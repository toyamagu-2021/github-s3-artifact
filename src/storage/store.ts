import {normalizeKeyPrefix} from '../shared/s3-config.js'
import type {
  ArtifactId,
  ArtifactManifestV1,
  ArtifactName,
  BucketName,
  RunScope,
  Sha256Digest,
  WriteGuard
} from '../shared/types.js'

export interface PutBlobOptions {
  readonly scope: RunScope
  readonly id: ArtifactId
  readonly body: NodeJS.ReadableStream
  readonly contentType: string
  readonly retentionDays?: number
}

export interface PutBlobResult {
  readonly blobKey: string
  readonly size: number
  readonly digest: Sha256Digest
  readonly artifactUrl: string
}

export interface ManifestLookupResult {
  readonly manifest: ArtifactManifestV1
  readonly etag?: string
  readonly expired: boolean
}

export interface ArtifactStore {
  getManifestWithMeta(
    scope: RunScope,
    name: ArtifactName
  ): Promise<ManifestLookupResult | null>
  putBlobStream(opts: PutBlobOptions): Promise<PutBlobResult>
  commitManifest(
    scope: RunScope,
    manifest: ArtifactManifestV1,
    guard: WriteGuard
  ): Promise<void>
  listManifests(scope: RunScope): Promise<ArtifactManifestV1[]>
  openBlobStream(blobKey: string): Promise<NodeJS.ReadableStream>
  deleteBlobBestEffort(blobKey: string): Promise<void>
  presignGetObject(blobKey: string, expiresInSeconds: number): Promise<string>
}

export const RETENTION_TAG_KEY = 's3-artifact-retention-days'

export function buildRunBasePrefix(keyPrefix: string, scope: RunScope): string {
  const normalized = normalizeKeyPrefix(keyPrefix)
  const runSegment = `${scope.repositoryOwner}/${scope.repositoryName}/runs/${scope.runId}`
  return normalized ? `${normalized}/${runSegment}` : runSegment
}

export function buildBlobKey(
  keyPrefix: string,
  scope: RunScope,
  id: ArtifactId
): string {
  return `${buildRunBasePrefix(keyPrefix, scope)}/blobs/${id}`
}

export function buildManifestPrefix(keyPrefix: string, scope: RunScope): string {
  return `${buildRunBasePrefix(keyPrefix, scope)}/manifests/`
}

export function buildManifestKey(
  keyPrefix: string,
  scope: RunScope,
  name: ArtifactName
): string {
  return `${buildManifestPrefix(keyPrefix, scope)}${encodeURIComponent(name)}.json`
}

export function buildArtifactS3Uri(bucket: BucketName, blobKey: string): string {
  return `s3://${bucket}/${blobKey}`
}

export function formatRetentionTagging(
  retentionDays: number | undefined
): string | undefined {
  if (retentionDays === undefined) {
    return undefined
  }
  return `${RETENTION_TAG_KEY}=${retentionDays}`
}
