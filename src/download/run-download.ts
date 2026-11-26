import * as core from '@actions/core'
import {Minimatch} from 'minimatch'
import * as path from 'node:path'
import {verifyDigestAndMaterialize} from '../core/extract-zip.js'
import {withBlobReadRetry} from '../shared/blob-transfer.js'
import {
  ArtifactNotFoundError,
  DigestMismatchError
} from '../shared/errors.js'
import type {ArtifactManifestV1} from '../shared/types.js'
import type {ArtifactStore} from '../storage/store.js'
import type {DownloadActionInputs} from './inputs.js'

const PARALLEL_DOWNLOADS = 5

export interface DownloadDeps {
  readonly store: ArtifactStore
}

function chunkArray<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

export async function runDownload(
  inputs: DownloadActionInputs,
  deps: DownloadDeps
): Promise<void> {
  let targets: ArtifactManifestV1[]
  const isSingleNamed = inputs.name !== undefined

  if (inputs.name !== undefined) {
    const found = await deps.store.getManifestWithMeta(inputs.scope, inputs.name)
    if (!found || found.expired) {
      throw new ArtifactNotFoundError(`Artifact '${inputs.name}' not found`)
    }
    targets = [found.manifest]
  } else if (inputs.artifactIds !== undefined) {
    const allManifests = await deps.store.listManifests(inputs.scope)
    const requested = new Set<string>(inputs.artifactIds)
    targets = allManifests.filter(m => requested.has(m.id))

    if (targets.length === 0) {
      throw new ArtifactNotFoundError('None of the provided artifact IDs were found')
    }

    if (targets.length < inputs.artifactIds.length) {
      const foundIds = new Set<string>(targets.map(t => t.id))
      const missingIds = inputs.artifactIds.filter(id => !foundIds.has(id))
      if (missingIds.length > 0) {
        core.warning(
          `Could not find the following artifact IDs: ${missingIds.join(', ')}`
        )
      }
    }
  } else {
    const allManifests = await deps.store.listManifests(inputs.scope)
    if (inputs.pattern) {
      const matcher = new Minimatch(inputs.pattern)
      targets = allManifests.filter(m => matcher.match(m.name))
    } else {
      targets = allManifests
    }
  }

  const extractDirectly =
    isSingleNamed || inputs.mergeMultiple || targets.length === 1

  const digestMismatches: string[] = []
  const abortOnDigestMismatch = inputs.digestMismatch === 'error'

  for (const batch of chunkArray(targets, PARALLEL_DOWNLOADS)) {
    const results = await Promise.all(
      batch.map(async manifest => {
        const destDir = extractDirectly
          ? inputs.destinationPath
          : path.join(inputs.destinationPath, manifest.name)
        const materialized = await withBlobReadRetry(
          () => deps.store.openBlobStream(manifest.blobKey),
          stream =>
            verifyDigestAndMaterialize({
              stream,
              expectedDigest: manifest.digest,
              destinationDir: destDir,
              archived: manifest.archived,
              rawFileName: manifest.rawFileName,
              skipDecompress: inputs.skipDecompress,
              abortOnDigestMismatch
            })
        )
        return {manifest, materialized}
      })
    )

    for (const {manifest, materialized} of results) {
      if (!materialized.digestMismatch) {
        continue
      }
      digestMismatches.push(manifest.name)
      const message = `Artifact '${manifest.name}' digest validation failed. Expected ${manifest.digest}, got ${materialized.actualDigest}.`
      switch (inputs.digestMismatch) {
        case 'ignore':
          break
        case 'info':
          core.info(message)
          break
        case 'warn':
          core.warning(message)
          break
        case 'error':
          break
      }
    }
  }

  if (digestMismatches.length > 0 && inputs.digestMismatch === 'error') {
    throw new DigestMismatchError(digestMismatches)
  }

  core.info(`Total of ${targets.length} artifact(s) downloaded`)
  core.setOutput('download-path', inputs.destinationPath)
  core.info('Download artifact has finished successfully')
}
