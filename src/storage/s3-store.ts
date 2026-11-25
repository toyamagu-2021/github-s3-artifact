import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  PutObjectTaggingCommand,
  S3Client,
  type PutObjectCommandInput
} from '@aws-sdk/client-s3'
import {Upload} from '@aws-sdk/lib-storage'
import {PassThrough, Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import * as core from '@actions/core'
import {createHashStream} from '../core/hash-stream.js'
import {ArtifactConflictError, ArtifactNotFoundError} from '../shared/errors.js'
import {
  type ArtifactManifestV1,
  type ArtifactName,
  type RunScope,
  type S3BackendConfig,
  type WriteGuard,
  isManifestExpired,
  parseManifestJson
} from '../shared/types.js'
import {
  type ArtifactStore,
  type PutBlobOptions,
  type PutBlobResult,
  RETENTION_TAG_KEY,
  buildArtifactS3Uri,
  buildBlobKey,
  buildManifestKey,
  buildManifestPrefix,
  formatRetentionTagging
} from './store.js'

const PART_SIZE_BYTES = 8 * 1024 * 1024
const MULTIPART_QUEUE_SIZE = 4
const MANIFEST_READ_CONCURRENCY = 10

export interface S3ArtifactStoreDeps {
  readonly client?: S3Client
  readonly warn?: (message: string) => void
  readonly now?: () => number
}

function getHttpStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) {
    return undefined
  }
  const meta = (error as {$metadata?: {httpStatusCode?: number}}).$metadata
  return meta?.httpStatusCode
}

function getErrorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return ''
  }
  const err = error as {name?: string; Code?: string; code?: string}
  return err.Code || err.code || err.name || ''
}

function isNotFoundError(error: unknown): boolean {
  const status = getHttpStatus(error)
  const code = getErrorCode(error)
  return status === 404 || code === 'NoSuchKey' || code === 'NotFound'
}

function isPreconditionFailed(error: unknown): boolean {
  const status = getHttpStatus(error)
  const code = getErrorCode(error)
  return (
    status === 412 ||
    status === 409 ||
    code === 'PreconditionFailed' ||
    code === 'ConditionalRequestConflict'
  )
}

function isConditionalUnsupported(error: unknown): boolean {
  const status = getHttpStatus(error)
  const code = getErrorCode(error)
  return status === 501 || code === 'NotImplemented'
}

function isTaggingRejection(error: unknown): boolean {
  const code = getErrorCode(error)
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  if (
    code === 'AccessDenied' ||
    code === 'NotImplemented' ||
    code === 'InvalidArgument' ||
    code === 'MethodNotAllowed' ||
    code === 'InvalidRequest'
  ) {
    return true
  }
  return message.includes('tagging') || message.includes('x-amz-tagging')
}

async function readStreamToUtf8(body: unknown): Promise<string> {
  if (!body) {
    return ''
  }
  if (typeof (body as {transformToString?: () => Promise<string>}).transformToString === 'function') {
    return (body as {transformToString: () => Promise<string>}).transformToString()
  }
  const chunks: Buffer[] = []
  for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

function toNodeReadable(body: unknown): NodeJS.ReadableStream {
  if (!body) {
    throw new Error('S3 GetObject response body is empty')
  }
  if (typeof (body as NodeJS.ReadableStream).pipe === 'function') {
    return body as NodeJS.ReadableStream
  }
  if (typeof (body as {transformToWebStream?: () => unknown}).transformToWebStream === 'function') {
    const webStream = (body as {transformToWebStream: () => ReadableStream<Uint8Array>}).transformToWebStream()
    return Readable.fromWeb(webStream as never)
  }
  throw new Error('Unsupported S3 response body stream type')
}

export class S3ArtifactStore implements ArtifactStore {
  private readonly client: S3Client
  private readonly warn: (message: string) => void
  private readonly now: () => number

  constructor(
    private readonly config: S3BackendConfig,
    deps: S3ArtifactStoreDeps = {}
  ) {
    this.warn = deps.warn ?? (msg => core.warning(msg))
    this.now = deps.now ?? (() => Date.now())
    this.client =
      deps.client ??
      new S3Client({
        region: config.region,
        endpoint: config.endpoint,
        forcePathStyle: config.forcePathStyle,
        credentials: config.credentials,
        // Disable automatic CRC32 trailing checksums for R2/MinIO/GCS compatibility.
        requestChecksumCalculation: 'WHEN_REQUIRED',
        responseChecksumValidation: 'WHEN_REQUIRED'
      })
  }

  async getManifestWithMeta(
    scope: RunScope,
    name: ArtifactName
  ): Promise<{
    readonly manifest: ArtifactManifestV1
    readonly etag?: string
    readonly expired: boolean
  } | null> {
    const key = buildManifestKey(this.config.keyPrefix, scope, name)
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: key
        })
      )
      const rawJson = await readStreamToUtf8(response.Body)
      const manifest = parseManifestJson(rawJson)
      return {
        manifest,
        etag: response.ETag,
        expired: isManifestExpired(manifest, this.now())
      }
    } catch (error) {
      if (isNotFoundError(error)) {
        return null
      }
      throw error
    }
  }

  async putBlobStream(opts: PutBlobOptions): Promise<PutBlobResult> {
    const blobKey = buildBlobKey(this.config.keyPrefix, opts.scope, opts.id)
    const result = await this.uploadBlobSingleAttempt(
      blobKey,
      opts.body,
      opts.contentType
    )
    if (opts.retentionDays !== undefined) {
      await this.applyBlobRetentionTagBestEffort(blobKey, opts.retentionDays)
    }
    return result
  }

  private async applyBlobRetentionTagBestEffort(
    blobKey: string,
    retentionDays: number
  ): Promise<void> {
    try {
      await this.client.send(
        new PutObjectTaggingCommand({
          Bucket: this.config.bucket,
          Key: blobKey,
          Tagging: {
            TagSet: [
              {
                Key: RETENTION_TAG_KEY,
                Value: String(retentionDays)
              }
            ]
          }
        })
      )
    } catch (error) {
      if (isTaggingRejection(error)) {
        this.warn(
          `S3 object tagging is unsupported or denied for blob '${blobKey}'; continuing without retention tag.`
        )
        return
      }
      throw error
    }
  }

  private async uploadBlobSingleAttempt(
    blobKey: string,
    body: NodeJS.ReadableStream,
    contentType: string
  ): Promise<PutBlobResult> {
    const hashTransform = createHashStream()
    const pass = new PassThrough()
    const streamPipe = pipeline(body, hashTransform, pass)

    const upload = new Upload({
      client: this.client,
      params: {
        Bucket: this.config.bucket,
        Key: blobKey,
        Body: pass,
        ContentType: contentType
      },
      partSize: PART_SIZE_BYTES,
      queueSize: MULTIPART_QUEUE_SIZE,
      leavePartsOnError: false
    })

    await Promise.all([upload.done(), streamPipe])
    const metrics = hashTransform.result()
    return {
      blobKey,
      size: metrics.size,
      digest: metrics.digest,
      artifactUrl: buildArtifactS3Uri(this.config.bucket, blobKey)
    }
  }

  async commitManifest(
    scope: RunScope,
    manifest: ArtifactManifestV1,
    guard: WriteGuard
  ): Promise<void> {
    const key = buildManifestKey(this.config.keyPrefix, scope, manifest.name)
    const body = JSON.stringify(manifest)
    const baseInput: PutObjectCommandInput = {
      Bucket: this.config.bucket,
      Key: key,
      Body: body,
      ContentType: 'application/json'
    }

    if (guard.mode === 'create-only') {
      baseInput.IfNoneMatch = '*'
    } else if (guard.mode === 'compare-and-swap') {
      baseInput.IfMatch = guard.etag
    }

    const tagging = formatRetentionTagging(manifest.retentionDays)
    if (tagging) {
      baseInput.Tagging = tagging
    }

    await this.putManifestWithFallbacks(baseInput, manifest.name)
  }

  private async putManifestWithFallbacks(
    input: PutObjectCommandInput,
    artifactName: ArtifactName
  ): Promise<void> {
    try {
      await this.client.send(new PutObjectCommand(input))
      return
    } catch (error) {
      if (isPreconditionFailed(error)) {
        throw new ArtifactConflictError(
          `Artifact '${artifactName}' already exists or was updated concurrently.`
        )
      }

      if (input.Tagging && isTaggingRejection(error)) {
        this.warn(
          `S3 object tagging is unsupported or denied for manifest '${artifactName}'; retrying upload without retention tag.`
        )
        const withoutTagging: PutObjectCommandInput = {...input}
        delete withoutTagging.Tagging
        await this.putManifestWithFallbacks(withoutTagging, artifactName)
        return
      }

      if ((input.IfNoneMatch || input.IfMatch) && isConditionalUnsupported(error)) {
        this.warn(
          `S3 conditional write headers are not supported by this endpoint (501 NotImplemented); retrying manifest PUT unconditionally for '${artifactName}'.`
        )
        const unconditional: PutObjectCommandInput = {...input}
        delete unconditional.IfNoneMatch
        delete unconditional.IfMatch
        await this.putManifestWithFallbacks(unconditional, artifactName)
        return
      }

      throw error
    }
  }

  async listManifests(scope: RunScope): Promise<ArtifactManifestV1[]> {
    const prefix = buildManifestPrefix(this.config.keyPrefix, scope)
    const keys: string[] = []
    let continuationToken: string | undefined

    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.config.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken
        })
      )
      for (const item of response.Contents ?? []) {
        if (item.Key && item.Key.endsWith('.json')) {
          keys.push(item.Key)
        }
      }
      continuationToken = response.IsTruncated
        ? response.NextContinuationToken
        : undefined
    } while (continuationToken)

    const nowMs = this.now()
    const manifests: ArtifactManifestV1[] = []
    for (let i = 0; i < keys.length; i += MANIFEST_READ_CONCURRENCY) {
      const batch = keys.slice(i, i + MANIFEST_READ_CONCURRENCY)
      const loaded = await Promise.all(
        batch.map(async key => {
          try {
            const res = await this.client.send(
              new GetObjectCommand({
                Bucket: this.config.bucket,
                Key: key
              })
            )
            const rawJson = await readStreamToUtf8(res.Body)
            return parseManifestJson(rawJson)
          } catch (error) {
            if (isNotFoundError(error)) {
              return null
            }
            throw error
          }
        })
      )
      for (const manifest of loaded) {
        if (manifest && !isManifestExpired(manifest, nowMs)) {
          manifests.push(manifest)
        }
      }
    }

    return manifests
  }

  async openBlobStream(blobKey: string): Promise<NodeJS.ReadableStream> {
    try {
      const response = await this.client.send(
        new GetObjectCommand({
          Bucket: this.config.bucket,
          Key: blobKey
        })
      )
      return toNodeReadable(response.Body)
    } catch (error) {
      if (isNotFoundError(error)) {
        throw new ArtifactNotFoundError(`Artifact blob not found: ${blobKey}`)
      }
      throw error
    }
  }

  async deleteBlobBestEffort(blobKey: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({
          Bucket: this.config.bucket,
          Key: blobKey
        })
      )
    } catch (error) {
      core.debug(
        `Best-effort deletion failed for blob '${blobKey}': ${(error as Error).message}`
      )
    }
  }
}
