import * as core from '@actions/core'
import * as fs from 'node:fs'
import * as path from 'node:path'
import {createZipArchiveStream} from '../core/archive-zip.js'
import {getMimeType} from '../core/mime-types.js'
import {buildZipSpecificationAsync, findFilesToUpload} from '../core/search.js'
import {
  ArtifactConflictError,
  ArtifactValidationError
} from '../shared/errors.js'
import {generateArtifactId} from '../shared/ids.js'
import {
  type ArtifactManifestV1,
  type WriteGuard,
  parseArtifactName,
  stripSha256Prefix
} from '../shared/types.js'
import type {ArtifactStore} from '../storage/store.js'
import type {UploadActionInputs} from './inputs.js'

const MS_PER_DAY = 24 * 60 * 60 * 1000

export interface UploadDeps {
  readonly store: ArtifactStore
  readonly now?: () => number
}

export async function runUpload(
  inputs: UploadActionInputs,
  deps: UploadDeps
): Promise<void> {
  const now = deps.now ?? (() => Date.now())

  if (inputs.archive) {
    parseArtifactName(inputs.artifactNameRaw)
  }

  const searchResult = await findFilesToUpload(
    inputs.searchPath,
    inputs.includeHiddenFiles
  )

  if (searchResult.filesToUpload.length === 0) {
    const message = `No files were found with the provided path: ${inputs.searchPath}. No artifacts will be uploaded.`
    switch (inputs.ifNoFilesFound) {
      case 'warn':
        core.warning(message)
        return
      case 'error':
        throw new ArtifactValidationError(message)
      case 'ignore':
        core.info(message)
        return
    }
  }

  if (!inputs.archive && searchResult.filesToUpload.length > 1) {
    throw new ArtifactValidationError(
      `When 'archive' is set to false, only a single file can be uploaded. Found ${searchResult.filesToUpload.length} files to upload.`
    )
  }

  const firstFile = searchResult.filesToUpload[0]!
  const resolvedNameRaw = inputs.archive
    ? inputs.artifactNameRaw
    : path.basename(firstFile)
  const artifactName = parseArtifactName(resolvedNameRaw)

  const zipSpecification = inputs.archive
    ? await buildZipSpecificationAsync(
        searchResult.filesToUpload,
        searchResult.rootDirectory
      )
    : []

  const existing = await deps.store.getManifestWithMeta(inputs.scope, artifactName)
  let guard: WriteGuard

  if (!existing) {
    guard = {mode: 'create-only'}
  } else if (
    existing.expired ||
    inputs.overwrite ||
    existing.manifest.runAttempt < inputs.scope.runAttempt
  ) {
    guard = existing.etag
      ? {mode: 'compare-and-swap', etag: existing.etag}
      : {mode: 'unconditional'}
  } else {
    throw new ArtifactConflictError(
      `Artifact '${artifactName}' already exists for run ${inputs.scope.runId} attempt ${inputs.scope.runAttempt}. Set 'overwrite: true' to replace it.`
    )
  }

  const rawFileName = inputs.archive ? `${artifactName}.zip` : path.basename(firstFile)
  const contentType = inputs.archive ? 'application/zip' : getMimeType(rawFileName)

  const artifactId = generateArtifactId(now())
  const uploadStream = inputs.archive
    ? await createZipArchiveStream(zipSpecification, inputs.compressionLevel)
    : fs.createReadStream(firstFile)

  const blobResult = await deps.store.putBlobStream({
    scope: inputs.scope,
    id: artifactId,
    body: uploadStream,
    contentType,
    retentionDays: inputs.retentionDays
  })

  const createdAtMs = now()
  const expiresAt =
    inputs.retentionDays !== undefined
      ? new Date(createdAtMs + inputs.retentionDays * MS_PER_DAY).toISOString()
      : undefined

  const manifest: ArtifactManifestV1 = {
    schemaVersion: 1,
    id: artifactId,
    name: artifactName,
    repository: `${inputs.scope.repositoryOwner}/${inputs.scope.repositoryName}`,
    runId: inputs.scope.runId,
    runAttempt: inputs.scope.runAttempt,
    blobKey: blobResult.blobKey,
    size: blobResult.size,
    digest: blobResult.digest,
    archived: inputs.archive,
    rawFileName,
    contentType,
    ...(inputs.retentionDays !== undefined
      ? {retentionDays: inputs.retentionDays}
      : {}),
    createdAt: new Date(createdAtMs).toISOString(),
    ...(expiresAt ? {expiresAt} : {})
  }

  try {
    await deps.store.commitManifest(inputs.scope, manifest, guard)
  } catch (error) {
    await deps.store.deleteBlobBestEffort(blobResult.blobKey)
    throw error
  }

  if (existing && existing.manifest.blobKey !== blobResult.blobKey) {
    await deps.store.deleteBlobBestEffort(existing.manifest.blobKey)
  }

  let artifactUrl = blobResult.artifactUrl
  if (inputs.artifactUrlFormat === 'presigned') {
    artifactUrl = await deps.store.presignGetObject(
      blobResult.blobKey,
      inputs.presignExpiresSeconds
    )
  }

  const hexDigest = stripSha256Prefix(blobResult.digest)
  core.info(
    `Artifact '${artifactName}' uploaded (${blobResult.size} bytes, ID ${artifactId}, digest ${hexDigest})`
  )
  core.setOutput('artifact-id', artifactId)
  core.setOutput('artifact-digest', hexDigest)
  core.setOutput('artifact-url', artifactUrl)
}
