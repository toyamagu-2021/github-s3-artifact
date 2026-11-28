import * as core from '@actions/core'
import type {S3BackendConfig} from '../shared/types.js'
import {S3ArtifactStore} from '../storage/s3-store.js'
import type {ArtifactStore} from '../storage/store.js'
import {parseDownloadInputs} from './inputs.js'
import {runDownload} from './run-download.js'

export interface DownloadEntrypointOptions {
  readonly createStore?: (config: S3BackendConfig) => ArtifactStore
  readonly env?: NodeJS.ProcessEnv
}

export async function runDownloadAction(
  opts: DownloadEntrypointOptions = {}
): Promise<void> {
  try {
    const env = opts.env ?? process.env
    const inputs = parseDownloadInputs(env)
    const store = opts.createStore
      ? opts.createStore(inputs.s3)
      : new S3ArtifactStore(inputs.s3, {env})
    await runDownload(inputs, {store})
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error))
  }
}
