import * as core from '@actions/core'
import {ArtifactValidationError} from '../shared/errors.js'
import {parseS3BackendConfig} from '../shared/s3-config.js'
import {
  type RunScope,
  type S3BackendConfig,
  parseRunScope
} from '../shared/types.js'

export interface MergeActionInputs {
  readonly name: string
  readonly pattern: string
  readonly separateDirectories: boolean
  readonly retentionDays?: number
  readonly compressionLevel: number
  readonly deleteMerged: boolean
  readonly includeHiddenFiles: boolean
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

export function parseMergeInputs(
  env: NodeJS.ProcessEnv = process.env
): MergeActionInputs {
  const name = getOptionalInput('name') ?? 'merged-artifacts'
  const pattern = getOptionalInput('pattern') ?? '*'
  const separateDirectories = getBooleanWithDefault('separate-directories', false)
  const deleteMerged = getBooleanWithDefault('delete-merged', false)
  const includeHiddenFiles = getBooleanWithDefault('include-hidden-files', false)

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

  const scope = parseRunScope({
    repository: env.GITHUB_REPOSITORY ?? '',
    runId: env.GITHUB_RUN_ID ?? '',
    runAttempt: env.GITHUB_RUN_ATTEMPT ?? '1'
  })

  return {
    name,
    pattern,
    separateDirectories,
    retentionDays,
    compressionLevel,
    deleteMerged,
    includeHiddenFiles,
    s3,
    scope
  }
}
