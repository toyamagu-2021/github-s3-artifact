import {ArtifactValidationError} from './errors.js'
import {type S3BackendConfig, parseBucketName} from './types.js'

export interface RawS3InputOverrides {
  readonly bucket?: string
  readonly keyPrefix?: string
  readonly region?: string
  readonly endpoint?: string
  readonly forcePathStyle?: string
  readonly accessKeyId?: string
  readonly secretAccessKey?: string
  readonly sessionToken?: string
}

function pickFirstNonEmpty(
  ...values: ReadonlyArray<string | undefined>
): string | undefined {
  for (const value of values) {
    if (value !== undefined) {
      const trimmed = value.trim()
      if (trimmed.length > 0) {
        return trimmed
      }
    }
  }
  return undefined
}

export function normalizeKeyPrefix(rawPrefix: string): string {
  return rawPrefix.trim().replace(/^\/+|\/+$/g, '')
}

function parseBooleanFlag(raw: string | undefined, name: string): boolean {
  if (raw === undefined) {
    return false
  }
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'true') {
    return true
  }
  if (normalized === 'false' || normalized === '') {
    return false
  }
  throw new ArtifactValidationError(
    `Invalid boolean value for '${name}': '${raw}'. Expected 'true' or 'false'.`
  )
}

export function parseS3BackendConfig(
  overrides: RawS3InputOverrides,
  env: NodeJS.ProcessEnv,
  maskSecret: (secret: string) => void
): S3BackendConfig {
  const rawBucket = pickFirstNonEmpty(overrides.bucket, env.S3_ARTIFACT_BUCKET)
  if (!rawBucket) {
    throw new ArtifactValidationError(
      "S3 bucket is required. Set input 'bucket' or environment variable 'S3_ARTIFACT_BUCKET'."
    )
  }
  const bucket = parseBucketName(rawBucket)

  const keyPrefix = normalizeKeyPrefix(
    pickFirstNonEmpty(overrides.keyPrefix, env.S3_ARTIFACT_KEY_PREFIX) ?? ''
  )

  const endpoint = pickFirstNonEmpty(
    overrides.endpoint,
    env.S3_ARTIFACT_ENDPOINT,
    env.AWS_ENDPOINT_URL_S3,
    env.AWS_ENDPOINT_URL
  )
  if (endpoint) {
    try {
      new URL(endpoint)
    } catch {
      throw new ArtifactValidationError(`Invalid S3 endpoint URL: '${endpoint}'`)
    }
  }

  const region =
    pickFirstNonEmpty(
      overrides.region,
      env.S3_ARTIFACT_REGION,
      env.AWS_REGION,
      env.AWS_DEFAULT_REGION
    ) ?? (endpoint ? 'auto' : 'us-east-1')

  const forcePathStyle = parseBooleanFlag(
    pickFirstNonEmpty(
      overrides.forcePathStyle,
      env.S3_ARTIFACT_FORCE_PATH_STYLE
    ),
    'force-path-style'
  )

  const accessKeyId = pickFirstNonEmpty(overrides.accessKeyId)
  const secretAccessKey = pickFirstNonEmpty(overrides.secretAccessKey)
  const sessionToken = pickFirstNonEmpty(overrides.sessionToken)

  if ((accessKeyId && !secretAccessKey) || (!accessKeyId && secretAccessKey)) {
    throw new ArtifactValidationError(
      "Both 'access-key-id' and 'secret-access-key' must be provided together when overriding credentials via action inputs."
    )
  }

  if (secretAccessKey) {
    maskSecret(secretAccessKey)
  }
  if (sessionToken) {
    maskSecret(sessionToken)
  }

  return {
    bucket,
    keyPrefix,
    region,
    endpoint,
    forcePathStyle,
    credentials:
      accessKeyId && secretAccessKey
        ? {
            accessKeyId,
            secretAccessKey,
            sessionToken
          }
        : undefined
  }
}
