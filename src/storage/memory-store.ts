import {createHash} from 'node:crypto'
import {Readable} from 'node:stream'
import {
  ArtifactConflictError,
  ArtifactNotFoundError,
  ArtifactValidationError
} from '../shared/errors.js'
import {
  type ArtifactManifestV1,
  type ArtifactName,
  type BucketName,
  type RunScope,
  type WriteGuard,
  isManifestExpired,
  parseManifestJson,
  parseSha256Digest
} from '../shared/types.js'
import {
  type ArtifactStore,
  type PutBlobOptions,
  type PutBlobResult,
  buildArtifactS3Uri,
  buildBlobKey,
  buildManifestKey,
  buildManifestPrefix
} from './store.js'

interface StoredManifestEntry {
  rawJson: string
  etag: string
}

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly blobs = new Map<string, Buffer>()
  private readonly manifests = new Map<string, StoredManifestEntry>()
  private readonly tags = new Map<string, string>()
  private etagSeq = 0

  constructor(
    private readonly bucket: BucketName,
    private readonly keyPrefix = '',
    private readonly now: () => number = () => Date.now()
  ) {}

  getBlobTags(blobKey: string): string | undefined {
    return this.tags.get(blobKey)
  }

  getManifestTags(scope: RunScope, name: ArtifactName): string | undefined {
    return this.tags.get(buildManifestKey(this.keyPrefix, scope, name))
  }

  setRawBlobForTesting(blobKey: string, content: Buffer): void {
    this.blobs.set(blobKey, content)
  }

  hasBlob(blobKey: string): boolean {
    return this.blobs.has(blobKey)
  }

  getManifestWithMeta(
    scope: RunScope,
    name: ArtifactName
  ): Promise<{
    readonly manifest: ArtifactManifestV1
    readonly etag?: string
    readonly expired: boolean
  } | null> {
    const key = buildManifestKey(this.keyPrefix, scope, name)
    const entry = this.manifests.get(key)
    if (!entry) {
      return Promise.resolve(null)
    }
    const manifest = parseManifestJson(entry.rawJson)
    return Promise.resolve({
      manifest,
      etag: entry.etag,
      expired: isManifestExpired(manifest, this.now())
    })
  }

  async putBlobStream(opts: PutBlobOptions): Promise<PutBlobResult> {
    const blobKey = buildBlobKey(this.keyPrefix, opts.scope, opts.id)
    const chunks: Buffer[] = []
    const hash = createHash('sha256')
    let size = 0

    for await (const chunk of opts.body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      chunks.push(buf)
      hash.update(buf)
      size += buf.length
    }

    this.blobs.set(blobKey, Buffer.concat(chunks))
    if (opts.retentionDays !== undefined) {
      this.tags.set(blobKey, `s3-artifact-retention-days=${opts.retentionDays}`)
    }

    return {
      blobKey,
      size,
      digest: parseSha256Digest(`sha256:${hash.digest('hex')}`),
      artifactUrl: buildArtifactS3Uri(this.bucket, blobKey)
    }
  }

  commitManifest(
    scope: RunScope,
    manifest: ArtifactManifestV1,
    guard: WriteGuard
  ): Promise<void> {
    const key = buildManifestKey(this.keyPrefix, scope, manifest.name)
    const existing = this.manifests.get(key)

    if (guard.mode === 'create-only' && existing) {
      return Promise.reject(
        new ArtifactConflictError(
          `Artifact '${manifest.name}' already exists for run ${scope.runId}.`
        )
      )
    }
    if (
      guard.mode === 'compare-and-swap' &&
      (!existing || existing.etag !== guard.etag)
    ) {
      return Promise.reject(
        new ArtifactConflictError(
          `Artifact '${manifest.name}' changed concurrently (ETag mismatch).`
        )
      )
    }

    this.etagSeq += 1
    const nextEtag = `"mem-${this.etagSeq}"`
    this.manifests.set(key, {
      rawJson: JSON.stringify(manifest),
      etag: nextEtag
    })
    if (manifest.retentionDays !== undefined) {
      this.tags.set(key, `s3-artifact-retention-days=${manifest.retentionDays}`)
    }
    return Promise.resolve()
  }

  listManifests(scope: RunScope): Promise<ArtifactManifestV1[]> {
    const prefix = buildManifestPrefix(this.keyPrefix, scope)
    const results: ArtifactManifestV1[] = []
    const nowMs = this.now()
    for (const [key, entry] of this.manifests.entries()) {
      if (!key.startsWith(prefix) || !key.endsWith('.json')) {
        continue
      }
      const manifest = parseManifestJson(entry.rawJson)
      if (!isManifestExpired(manifest, nowMs)) {
        results.push(manifest)
      }
    }
    return Promise.resolve(results)
  }

  openBlobStream(blobKey: string): Promise<NodeJS.ReadableStream> {
    const data = this.blobs.get(blobKey)
    if (!data) {
      return Promise.reject(
        new ArtifactNotFoundError(`Artifact blob not found: ${blobKey}`)
      )
    }
    return Promise.resolve(Readable.from(data))
  }

  deleteBlobBestEffort(blobKey: string): Promise<void> {
    this.blobs.delete(blobKey)
    this.tags.delete(blobKey)
    return Promise.resolve()
  }

  presignGetObject(_blobKey: string, _expiresInSeconds: number): Promise<string> {
    return Promise.reject(
      new ArtifactValidationError(
        'Presigned artifact URLs require an S3 client'
      )
    )
  }
}
