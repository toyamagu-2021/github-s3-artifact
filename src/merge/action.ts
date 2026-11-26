import * as core from '@actions/core'
import type {S3BackendConfig} from '../shared/types.js'
import {S3ArtifactStore} from '../storage/s3-store.js'
import type {ArtifactStore} from '../storage/store.js'
import {parseMergeInputs} from './inputs.js'
import {runMerge} from './run-merge.js'

export interface MergeEntrypointOptions {
  readonly createStore?: (config: S3BackendConfig) => ArtifactStore
  readonly now?: () => number
  readonly env?: NodeJS.ProcessEnv
}

export async function runMergeAction(
  opts: MergeEntrypointOptions = {}
): Promise<void> {
  try {
    const inputs = parseMergeInputs(opts.env ?? process.env)
    const store = opts.createStore
      ? opts.createStore(inputs.s3)
      : new S3ArtifactStore(inputs.s3)
    await runMerge(inputs, {store, now: opts.now})
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error))
  }
}
