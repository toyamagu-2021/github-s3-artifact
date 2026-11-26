import * as os from 'node:os'
import * as core from '@actions/core'

const ABSOLUTE_CONCURRENCY_CAP = 300

export function concurrencyCapForCpu(numCPUs: number): number {
  let concurrencyCap = 32
  if (numCPUs > 4) {
    const concurrency = 16 * numCPUs
    concurrencyCap = concurrency > ABSOLUTE_CONCURRENCY_CAP ? ABSOLUTE_CONCURRENCY_CAP : concurrency
  }
  return concurrencyCap
}

function parsePositiveIntEnv(raw: string, varName: string): number {
  const trimmed = raw.trim()
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid value set for ${varName} env variable`)
  }
  const parsed = Number(trimmed)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid value set for ${varName} env variable`)
  }
  return parsed
}

export function getConcurrency(
  env: NodeJS.ProcessEnv = process.env,
  numCPUs: number = os.cpus().length
): number {
  const concurrencyCap = concurrencyCapForCpu(numCPUs)
  const concurrencyOverride = env.ACTIONS_ARTIFACT_UPLOAD_CONCURRENCY?.trim()
  if (concurrencyOverride) {
    const concurrency = parsePositiveIntEnv(
      concurrencyOverride,
      'ACTIONS_ARTIFACT_UPLOAD_CONCURRENCY'
    )
    if (concurrency < concurrencyCap) {
      core.info(
        'Set concurrency based on the value set in ACTIONS_ARTIFACT_UPLOAD_CONCURRENCY.'
      )
      return concurrency
    }
    core.info(
      `ACTIONS_ARTIFACT_UPLOAD_CONCURRENCY is higher than the cap of ${concurrencyCap} based on the number of cpus. Set it to the maximum value allowed.`
    )
    return concurrencyCap
  }
  return 5
}

export function getUploadChunkTimeout(env: NodeJS.ProcessEnv = process.env): number {
  const timeoutVar = env.ACTIONS_ARTIFACT_UPLOAD_TIMEOUT_MS?.trim()
  if (!timeoutVar) {
    return 300000
  }
  return parsePositiveIntEnv(timeoutVar, 'ACTIONS_ARTIFACT_UPLOAD_TIMEOUT_MS')
}

export function getMaxArtifactListCount(env: NodeJS.ProcessEnv = process.env): number {
  const maxCountVar = env.ACTIONS_ARTIFACT_MAX_ARTIFACT_COUNT?.trim()
  if (!maxCountVar) {
    return 1000
  }
  return parsePositiveIntEnv(maxCountVar, 'ACTIONS_ARTIFACT_MAX_ARTIFACT_COUNT')
}

export function artifactListLimitMessage(maxCount: number): string {
  return `Artifact list exceeded the limit of ${maxCount}. Results will be incomplete as only the first ${maxCount} artifacts will be returned`
}
