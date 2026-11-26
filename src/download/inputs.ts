import * as core from '@actions/core'
import * as os from 'node:os'
import * as path from 'node:path'
import {ArtifactValidationError} from '../shared/errors.js'
import {parseS3BackendConfig} from '../shared/s3-config.js'
import {
  type ArtifactId,
  type ArtifactName,
  type RunScope,
  type S3BackendConfig,
  parseArtifactId,
  parseArtifactName,
  parseRunScope
} from '../shared/types.js'

export type DigestMismatchBehavior = 'ignore' | 'info' | 'warn' | 'error'

export interface DownloadActionInputs {
  readonly name?: ArtifactName
  readonly artifactIds?: readonly ArtifactId[]
  readonly pattern?: string
  readonly mergeMultiple: boolean
  readonly destinationPath: string
  readonly skipDecompress: boolean
  readonly digestMismatch: DigestMismatchBehavior
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

export function expandDestinationPath(
  rawPath: string | undefined,
  env: NodeJS.ProcessEnv,
  pathApi: path.PlatformPath = path
): string {
  const target = rawPath || env.GITHUB_WORKSPACE || process.cwd()
  if (target.startsWith('~')) {
    const home = env.HOME || os.homedir()
    return pathApi.resolve(target.replace('~', home))
  }
  return pathApi.resolve(target)
}

export function parseDownloadInputs(
  env: NodeJS.ProcessEnv = process.env
): DownloadActionInputs {
  const rawName = getOptionalInput('name')
  const rawArtifactIds = getOptionalInput('artifact-ids')
  const pattern = getOptionalInput('pattern')

  if (rawName && rawArtifactIds) {
    throw new ArtifactValidationError(
      "Inputs 'name' and 'artifact-ids' cannot be used together. Please specify only one."
    )
  }

  const name = rawName !== undefined ? parseArtifactName(rawName) : undefined

  let artifactIds: ArtifactId[] | undefined
  if (rawArtifactIds !== undefined) {
    const tokens = rawArtifactIds
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0)
    if (tokens.length === 0) {
      throw new ArtifactValidationError(
        "No valid artifact IDs provided in 'artifact-ids' input"
      )
    }
    artifactIds = tokens.map(token => parseArtifactId(token))
  }

  const digestBehaviorRaw = (
    getOptionalInput('digest-mismatch') ?? 'error'
  ).toLowerCase()
  if (
    digestBehaviorRaw !== 'ignore' &&
    digestBehaviorRaw !== 'info' &&
    digestBehaviorRaw !== 'warn' &&
    digestBehaviorRaw !== 'error'
  ) {
    throw new ArtifactValidationError(
      `Invalid value for 'digest-mismatch': '${digestBehaviorRaw}'. Valid options are: ignore, info, warn, error`
    )
  }

  const mergeMultiple = getBooleanWithDefault('merge-multiple', false)
  const skipDecompress = getBooleanWithDefault('skip-decompress', false)
  const destinationPath = expandDestinationPath(getOptionalInput('path'), env)

  const repository = getOptionalInput('repository') ?? env.GITHUB_REPOSITORY ?? ''
  const runId = getOptionalInput('run-id') ?? env.GITHUB_RUN_ID ?? ''
  const runAttempt = env.GITHUB_RUN_ATTEMPT ?? '1'
  const scope = parseRunScope({repository, runId, runAttempt})

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

  return {
    name,
    artifactIds,
    pattern,
    mergeMultiple,
    destinationPath,
    skipDecompress,
    digestMismatch: digestBehaviorRaw,
    s3,
    scope
  }
}
