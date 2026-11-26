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

export function getConcurrency(
  env: NodeJS.ProcessEnv = process.env,
  numCPUs: number = os.cpus().length
): number {
  const concurrencyCap = concurrencyCapForCpu(numCPUs)
  const concurrencyOverride = env.ACTIONS_ARTIFACT_UPLOAD_CONCURRENCY
  if (concurrencyOverride) {
    const concurrency = parseInt(concurrencyOverride, 10)
    if (Number.isNaN(concurrency) || concurrency < 1) {
      throw new Error(
        'Invalid value set for ACTIONS_ARTIFACT_UPLOAD_CONCURRENCY env variable'
      )
    }
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
  const timeoutVar = env.ACTIONS_ARTIFACT_UPLOAD_TIMEOUT_MS
  if (!timeoutVar) {
    return 300000
  }
  const timeout = parseInt(timeoutVar, 10)
  if (Number.isNaN(timeout)) {
    throw new Error(
      'Invalid value set for ACTIONS_ARTIFACT_UPLOAD_TIMEOUT_MS env variable'
    )
  }
  return timeout
}

export function getMaxArtifactListCount(env: NodeJS.ProcessEnv = process.env): number {
  const maxCountVar = env.ACTIONS_ARTIFACT_MAX_ARTIFACT_COUNT || '1000'
  const maxCount = parseInt(maxCountVar, 10)
  if (Number.isNaN(maxCount) || maxCount < 1) {
    throw new Error(
      'Invalid value set for ACTIONS_ARTIFACT_MAX_ARTIFACT_COUNT env variable'
    )
  }
  return maxCount
}

export function artifactListLimitMessage(maxCount: number): string {
  return `Artifact list exceeded the limit of ${maxCount}. Results will be incomplete as only the first ${maxCount} artifacts will be returned`
}
