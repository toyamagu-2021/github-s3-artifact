import {ZipArchive, type ArchiverError} from 'archiver'
import * as core from '@actions/core'
import * as fs from 'node:fs/promises'
import {PassThrough} from 'node:stream'
import type {ZipFileEntrySpec} from './search.js'

const ARCHIVE_CHUNK_SIZE = 8 * 1024 * 1024
export const DEFAULT_COMPRESSION_LEVEL = 6

export async function createZipArchiveStream(
  entries: readonly ZipFileEntrySpec[],
  compressionLevel: number = DEFAULT_COMPRESSION_LEVEL
): Promise<NodeJS.ReadableStream> {
  const archive = new ZipArchive({
    highWaterMark: ARCHIVE_CHUNK_SIZE,
    zlib: {level: compressionLevel}
  })

  const output = new PassThrough({
    highWaterMark: ARCHIVE_CHUNK_SIZE
  })

  archive.on('warning', (err: ArchiverError) => {
    if (err.code === 'ENOENT') {
      core.warning(`ENOENT warning during zip creation: ${err.message}`)
      return
    }
    core.warning(`Warning during zip creation (${err.code}): ${err.message}`)
  })

  archive.on('error', (err: ArchiverError) => {
    output.destroy(err)
  })

  archive.pipe(output)

  for (const entry of entries) {
    const resolvedSource = entry.isSymbolicLink
      ? await fs.realpath(entry.sourcePath)
      : entry.sourcePath
    archive.file(resolvedSource, {name: entry.archivePath})
  }

  void archive.finalize()
  return output
}
