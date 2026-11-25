import {ArtifactValidationError} from './errors.js'
import {validateArtifactName} from './validation.js'

export type BucketName = string & {readonly __brand: 'BucketName'}
export type ArtifactId = string & {readonly __brand: 'ArtifactId'}
export type ArtifactName = string & {readonly __brand: 'ArtifactName'}
export type Sha256Digest = `sha256:${string}`

export interface RunScope {
  readonly repositoryOwner: string
  readonly repositoryName: string
  readonly runId: number
  readonly runAttempt: number
}

export interface S3BackendConfig {
  readonly bucket: BucketName
  readonly keyPrefix: string
  readonly region: string
  readonly endpoint?: string
  readonly forcePathStyle: boolean
  readonly credentials?: {
    readonly accessKeyId: string
    readonly secretAccessKey: string
    readonly sessionToken?: string
  }
}

export interface ArtifactManifestV1 {
  readonly schemaVersion: 1
  readonly id: ArtifactId
  readonly name: ArtifactName
  readonly repository: `${string}/${string}`
  readonly runId: number
  readonly runAttempt: number
  readonly blobKey: string
  readonly size: number
  readonly digest: Sha256Digest
  readonly archived: boolean
  readonly rawFileName: string
  readonly contentType: string
  readonly retentionDays?: number
  readonly createdAt: string
  readonly expiresAt?: string
}

export type WriteGuard =
  | {readonly mode: 'create-only'}
  | {readonly mode: 'compare-and-swap'; readonly etag: string}
  | {readonly mode: 'unconditional'}

const SHA256_DIGEST_RE = /^sha256:[0-9a-f]{64}$/
const POSITIVE_INT_RE = /^[1-9]\d*$/
const REPO_SEGMENT_RE = /^[A-Za-z0-9._-]+$/

export function parseBucketName(raw: string): BucketName {
  const trimmed = raw.trim()
  if (!trimmed || /[/\\\s]/.test(trimmed)) {
    throw new ArtifactValidationError(`Invalid S3 bucket name: '${raw}'`)
  }
  return trimmed as BucketName
}

export function parseArtifactId(raw: string): ArtifactId {
  const trimmed = raw.trim()
  if (!POSITIVE_INT_RE.test(trimmed)) {
    throw new ArtifactValidationError(
      `Invalid artifact ID '${raw}': expected a positive 53-bit integer.`
    )
  }
  const numeric = Number(trimmed)
  if (!Number.isSafeInteger(numeric) || numeric <= 0) {
    throw new ArtifactValidationError(
      `Invalid artifact ID '${raw}': exceeds 53-bit safe integer bounds.`
    )
  }
  return String(numeric) as ArtifactId
}

export function parseArtifactName(raw: string): ArtifactName {
  validateArtifactName(raw)
  return raw as ArtifactName
}

export function parseSha256Digest(raw: string): Sha256Digest {
  if (!SHA256_DIGEST_RE.test(raw)) {
    throw new ArtifactValidationError(
      `Invalid SHA-256 digest '${raw}': expected 'sha256:<64 hex chars>'.`
    )
  }
  return raw as Sha256Digest
}

export function stripSha256Prefix(digest: Sha256Digest): string {
  return digest.slice('sha256:'.length)
}

export function parseRunScope(raw: {
  readonly repository: string
  readonly runId: string | number
  readonly runAttempt?: string | number
}): RunScope {
  const parts = raw.repository.trim().split('/')
  if (
    parts.length !== 2 ||
    !parts[0] ||
    !parts[1] ||
    !REPO_SEGMENT_RE.test(parts[0]) ||
    !REPO_SEGMENT_RE.test(parts[1])
  ) {
    throw new ArtifactValidationError(
      `Invalid repository: '${raw.repository}'. Must be in format owner/repo`
    )
  }

  const runIdNum =
    typeof raw.runId === 'number' ? raw.runId : Number(String(raw.runId).trim())
  if (!Number.isSafeInteger(runIdNum) || runIdNum <= 0) {
    throw new ArtifactValidationError(
      `Invalid run-id: '${raw.runId}'. Must be a positive integer.`
    )
  }

  const attemptInput = raw.runAttempt ?? 1
  const runAttemptNum =
    typeof attemptInput === 'number'
      ? attemptInput
      : Number(String(attemptInput).trim() || '1')
  if (!Number.isSafeInteger(runAttemptNum) || runAttemptNum <= 0) {
    throw new ArtifactValidationError(
      `Invalid run-attempt: '${String(attemptInput)}'. Must be a positive integer.`
    )
  }

  return {
    repositoryOwner: parts[0],
    repositoryName: parts[1],
    runId: runIdNum,
    runAttempt: runAttemptNum
  }
}

export function parseManifestJson(rawJson: string): ArtifactManifestV1 {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawJson)
  } catch (error) {
    throw new ArtifactValidationError(
      `Malformed manifest JSON: ${(error as Error).message}`
    )
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ArtifactValidationError('Manifest JSON must be an object')
  }

  const obj = parsed as Record<string, unknown>
  if (obj.schemaVersion !== 1) {
    throw new ArtifactValidationError(
      `Unsupported manifest schemaVersion: ${String(obj.schemaVersion)}`
    )
  }
  if (typeof obj.id !== 'string') {
    throw new ArtifactValidationError('Manifest field id must be a string')
  }
  const id = parseArtifactId(obj.id)

  if (typeof obj.name !== 'string') {
    throw new ArtifactValidationError('Manifest field name must be a string')
  }
  const name = parseArtifactName(obj.name)

  if (typeof obj.repository !== 'string') {
    throw new ArtifactValidationError(
      'Manifest field repository must be a string'
    )
  }
  if (typeof obj.runId !== 'number') {
    throw new ArtifactValidationError('Manifest field runId must be a number')
  }
  if (typeof obj.runAttempt !== 'number') {
    throw new ArtifactValidationError(
      'Manifest field runAttempt must be a number'
    )
  }
  const scope = parseRunScope({
    repository: obj.repository,
    runId: obj.runId,
    runAttempt: obj.runAttempt
  })

  if (typeof obj.blobKey !== 'string' || !obj.blobKey) {
    throw new ArtifactValidationError(
      'Manifest field blobKey must be a non-empty string'
    )
  }
  if (
    typeof obj.size !== 'number' ||
    !Number.isSafeInteger(obj.size) ||
    obj.size < 0
  ) {
    throw new ArtifactValidationError(
      'Manifest field size must be a non-negative integer'
    )
  }
  if (typeof obj.digest !== 'string') {
    throw new ArtifactValidationError('Manifest field digest must be a string')
  }
  const digest = parseSha256Digest(obj.digest)

  if (typeof obj.archived !== 'boolean') {
    throw new ArtifactValidationError(
      'Manifest field archived must be a boolean'
    )
  }
  if (typeof obj.rawFileName !== 'string' || !obj.rawFileName) {
    throw new ArtifactValidationError(
      'Manifest field rawFileName must be a non-empty string'
    )
  }
  if (typeof obj.contentType !== 'string' || !obj.contentType) {
    throw new ArtifactValidationError(
      'Manifest field contentType must be a non-empty string'
    )
  }
  if (typeof obj.createdAt !== 'string' || Number.isNaN(Date.parse(obj.createdAt))) {
    throw new ArtifactValidationError(
      'Manifest field createdAt must be an ISO timestamp string'
    )
  }
  if (
    obj.retentionDays !== undefined &&
    (typeof obj.retentionDays !== 'number' ||
      !Number.isSafeInteger(obj.retentionDays) ||
      obj.retentionDays <= 0)
  ) {
    throw new ArtifactValidationError(
      'Manifest field retentionDays must be a positive integer'
    )
  }
  if (
    obj.expiresAt !== undefined &&
    (typeof obj.expiresAt !== 'string' || Number.isNaN(Date.parse(obj.expiresAt)))
  ) {
    throw new ArtifactValidationError(
      'Manifest field expiresAt must be an ISO timestamp string'
    )
  }

  return {
    schemaVersion: 1,
    id,
    name,
    repository: `${scope.repositoryOwner}/${scope.repositoryName}`,
    runId: scope.runId,
    runAttempt: scope.runAttempt,
    blobKey: obj.blobKey,
    size: obj.size,
    digest,
    archived: obj.archived,
    rawFileName: obj.rawFileName,
    contentType: obj.contentType,
    retentionDays: obj.retentionDays,
    createdAt: obj.createdAt,
    expiresAt: obj.expiresAt
  }
}

export function isManifestExpired(
  manifest: ArtifactManifestV1,
  nowMs: number = Date.now()
): boolean {
  if (!manifest.expiresAt) {
    return false
  }
  return Date.parse(manifest.expiresAt) <= nowMs
}
