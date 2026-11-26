import * as core from '@actions/core'
import {Minimatch} from 'minimatch'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {verifyDigestAndMaterialize} from '../core/extract-zip.js'
import {ArtifactValidationError, DigestMismatchError} from '../shared/errors.js'
import {type ArtifactManifestV1, parseArtifactName} from '../shared/types.js'
import type {ArtifactStore} from '../storage/store.js'
import {runUpload} from '../upload/run-upload.js'
import type {MergeActionInputs} from './inputs.js'

const PARALLEL_DOWNLOADS = 5

export interface MergeDeps {
  readonly store: ArtifactStore
  readonly now?: () => number
}

function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

export async function runMerge(
  inputs: MergeActionInputs,
  deps: MergeDeps
): Promise<void> {
  const mergedName = parseArtifactName(inputs.name)
  const manifests = await deps.store.listManifests(inputs.scope)
  const matcher = new Minimatch(inputs.pattern)
  const sources = manifests.filter(manifest => matcher.match(manifest.name))
  core.debug(
    `Filtered from ${manifests.length} to ${sources.length} artifacts`
  )

  if (sources.length === 0) {
    throw new ArtifactValidationError(
      `No artifacts found matching pattern '${inputs.pattern}'`
    )
  }

  core.info('Preparing to download the following artifacts:')
  for (const artifact of sources) {
    core.info(`- ${artifact.name} (ID: ${artifact.id}, Size: ${artifact.size})`)
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'merge-artifact-'))
  try {
    const mismatches = await extractSources(sources, inputs, deps.store, tmpDir)
    if (mismatches.length > 0) {
      throw new DigestMismatchError(mismatches)
    }

    await runUpload(
      {
        artifactNameRaw: mergedName,
        searchPath: tmpDir,
        ifNoFilesFound: 'error',
        retentionDays: inputs.retentionDays,
        compressionLevel: inputs.compressionLevel,
        overwrite: false,
        includeHiddenFiles: inputs.includeHiddenFiles,
        archive: true,
        s3: inputs.s3,
        scope: inputs.scope
      },
      {store: deps.store, now: deps.now}
    )

    core.info(
      `The ${sources.length} artifact(s) have been successfully merged!`
    )

    if (inputs.deleteMerged) {
      let deleted = 0
      for (const artifact of sources) {
        if (artifact.name === mergedName) {
          continue
        }
        await deps.store.deleteArtifact(inputs.scope, artifact.name)
        deleted += 1
      }
      core.info(`The ${deleted} artifact(s) have been deleted`)
    }
  } finally {
    await fs.rm(tmpDir, {recursive: true, force: true}).catch(error => {
      core.warning(
        `Unable to remove temporary directory: ${error instanceof Error ? error.message : String(error)}`
      )
    })
  }
}

async function extractSources(
  sources: readonly ArtifactManifestV1[],
  inputs: MergeActionInputs,
  store: ArtifactStore,
  tmpDir: string
): Promise<string[]> {
  const mismatches: string[] = []
  const concurrency = inputs.separateDirectories ? PARALLEL_DOWNLOADS : 1
  for (const batch of chunkArray(sources, concurrency)) {
    const results = await Promise.all(
      batch.map(async artifact => {
        const destinationDir = inputs.separateDirectories
          ? path.join(tmpDir, artifact.name)
          : tmpDir
        const stream = await store.openBlobStream(artifact.blobKey)
        const materialized = await verifyDigestAndMaterialize({
          stream,
          expectedDigest: artifact.digest,
          destinationDir,
          archived: artifact.archived,
          rawFileName: artifact.rawFileName,
          skipDecompress: false,
          abortOnDigestMismatch: true
        })
        return {name: artifact.name, mismatch: materialized.digestMismatch}
      })
    )
    for (const result of results) {
      if (result.mismatch) {
        mismatches.push(result.name)
      }
    }
  }
  return mismatches
}
