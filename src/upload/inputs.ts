import * as core from '@actions/core'
import {ArtifactValidationError} from '../shared/errors.js'
import {parseS3BackendConfig} from '../shared/s3-config.js'
import {
  type RunScope,
  type S3BackendConfig,
  parseRunScope
} from '../shared/types.js'

export type NoFileBehavior = 'warn' | 'error' | 'ignore'

export interface UploadActionInputs {
  readonly artifactNameRaw: string
  readonly searchPath: string
  readonly ifNoFilesFound: NoFileBehavior
  readonly retentionDays?: number
  readonly compressionLevel: number
  readonly overwrite: boolean
  readonly includeHiddenFiles: boolean
  readonly archive: boolean
  readonly artifactUrlFormat: 's3' | 'presigned'
  readonly presignExpiresSeconds: number
  readonly s3: S3BackendConfig
  readonly scope: RunScope
}

function getOptionalInput(name: string): string | undefined {
  const value = core.getInput(name, {required: false})
  return value === '' ? undefined : value
}

function getBooleanWithDefault(name: string, defaultValue: boolean): boolean {
  const raw = core.getInput(name, {required: false})
  if (!raw) {
    return defaultValue
  }
  return core.getBooleanInput(name, {required: false})
}

function parseIntegerInput(
  raw: string | undefined,
  name: string,
  min: number,
  max: number
): number | undefined {
  if (raw === undefined) {
    return undefined
  }
  const parsed = Number(raw.trim())
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ArtifactValidationError(
      `Invalid '${name}': '${raw}'. Expected an integer between ${min} and ${max}.`
    )
  }
  return parsed
}

function clampRetentionDays(
  requested: number | undefined,
  env: NodeJS.ProcessEnv
): number | undefined {
  if (requested === undefined || requested === 0) {
    return undefined
  }
  const repoLimitRaw = env.GITHUB_RETENTION_DAYS
  if (repoLimitRaw) {
    const repoLimit = Number(repoLimitRaw.trim())
    if (Number.isInteger(repoLimit) && repoLimit > 0 && repoLimit < requested) {
      core.warning(
        `Retention days cannot be greater than the maximum allowed retention set within the repository. Using ${repoLimit} instead.`
      )
      return repoLimit
    }
  }
  return requested
}

export function parseUploadInputs(
  env: NodeJS.ProcessEnv = process.env
): UploadActionInputs {
  const artifactNameRaw = getOptionalInput('name') ?? 'artifact'
  const searchPath = core.getInput('path', {required: true})
  const ifNoFilesRaw = (getOptionalInput('if-no-files-found') ?? 'warn').toLowerCase()
  if (
    ifNoFilesRaw !== 'warn' &&
    ifNoFilesRaw !== 'error' &&
    ifNoFilesRaw !== 'ignore'
  ) {
    throw new ArtifactValidationError(
      `Unrecognized if-no-files-found input: '${ifNoFilesRaw}'. Expected one of: warn, error, ignore.`
    )
  }

  const retentionRaw = getOptionalInput('retention-days')
  let retentionDays: number | undefined
  if (retentionRaw !== undefined) {
    const parsedRetention = Number(retentionRaw.trim())
    if (!Number.isInteger(parsedRetention) || parsedRetention < 0) {
      throw new ArtifactValidationError(
        `Invalid retention-days: '${retentionRaw}'. Expected a non-negative integer.`
      )
    }
    retentionDays = clampRetentionDays(parsedRetention, env)
  }

  const compressionLevel =
    parseIntegerInput(
      getOptionalInput('compression-level'),
      'compression-level',
      0,
      9
    ) ?? 6

  const overwrite = getBooleanWithDefault('overwrite', false)
  const includeHiddenFiles = getBooleanWithDefault('include-hidden-files', false)
  const archive = getBooleanWithDefault('archive', true)
  const envUrlFormat = env.S3_ARTIFACT_URL_FORMAT?.trim() || undefined
  const formatRaw = (
    getOptionalInput('artifact-url-format') ??
    envUrlFormat ??
    's3'
  )
    .trim()
    .toLowerCase()
  if (formatRaw !== 's3' && formatRaw !== 'presigned') {
    throw new ArtifactValidationError(
      `Unrecognized artifact-url-format: '${formatRaw}'. Expected s3 or presigned.`
    )
  }
  const envExpires = env.S3_ARTIFACT_PRESIGN_EXPIRES_SECONDS?.trim() || undefined
  const expiresRaw =
    getOptionalInput('presign-expires-seconds') ?? envExpires
  let presignExpiresSeconds = 3600
  if (expiresRaw !== undefined) {
    const parsedExpires = Number(expiresRaw.trim())
    if (
      !Number.isInteger(parsedExpires) ||
      parsedExpires < 1 ||
      parsedExpires > 604800
    ) {
      throw new ArtifactValidationError(
        `Invalid presign-expires-seconds: '${expiresRaw}'. Expected an integer from 1 to 604800.`
      )
    }
    presignExpiresSeconds = parsedExpires
  }

  const s3 = parseS3BackendConfig(
    {
      bucket: getOptionalInput('bucket'),
      keyPrefix: getOptionalInput('key-prefix'),
      region: getOptionalInput('region'),
      endpoint: getOptionalInput('endpoint'),
      forcePathStyle: getOptionalInput('force-path-style'),
      accessKeyId: getOptionalInput('access-key-id'),
      secretAccessKey: getOptionalInput('secret-access-key'),
      sessionToken: getOptionalInput('session-token')
    },
    env,
    secret => core.setSecret(secret)
  )

  const repository = env.GITHUB_REPOSITORY ?? ''
  const runId = env.GITHUB_RUN_ID ?? ''
  const runAttempt = env.GITHUB_RUN_ATTEMPT ?? '1'
  const scope = parseRunScope({repository, runId, runAttempt})

  return {
    artifactNameRaw,
    searchPath,
    ifNoFilesFound: ifNoFilesRaw,
    retentionDays,
    compressionLevel,
    overwrite,
    includeHiddenFiles,
    archive,
    artifactUrlFormat: formatRaw,
    presignExpiresSeconds,
    s3,
    scope
  }
}
