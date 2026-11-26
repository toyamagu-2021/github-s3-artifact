import * as core from '@actions/core'
import {randomBytes} from 'node:crypto'
import * as fsSync from 'node:fs'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {Readable} from 'node:stream'
import {pipeline} from 'node:stream/promises'
import yauzl from 'yauzl'
import {ZipSlipError} from '../shared/errors.js'
import type {Sha256Digest} from '../shared/types.js'
import {createHashStream} from './hash-stream.js'

export interface MaterializeOptions {
  readonly stream: NodeJS.ReadableStream
  readonly expectedDigest: Sha256Digest
  readonly destinationDir: string
  readonly archived: boolean
  readonly rawFileName: string
  readonly skipDecompress: boolean
  readonly abortOnDigestMismatch?: boolean
}

export interface MaterializeResult {
  readonly actualDigest: Sha256Digest
  readonly digestMismatch: boolean
}

export function resolveSafeEntryPath(
  destinationDir: string,
  entryFileName: string
): string {
  const normalizedName = entryFileName.replace(/\\/g, '/')
  if (
    !normalizedName ||
    normalizedName.startsWith('/') ||
    /^[A-Za-z]:/.test(normalizedName) ||
    normalizedName.includes('\0')
  ) {
    throw new ZipSlipError(entryFileName)
  }

  const segments = normalizedName.split('/')
  if (segments.some(seg => seg === '..')) {
    throw new ZipSlipError(entryFileName)
  }

  const resolvedDest = path.resolve(destinationDir)
  const targetPath = path.resolve(resolvedDest, normalizedName)
  const rel = path.relative(resolvedDest, targetPath)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ZipSlipError(entryFileName)
  }

  return targetPath
}

function makeTempFilePath(dir: string, prefix: string): string {
  return path.join(
    dir,
    `${prefix}-${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`
  )
}

async function spoolStreamToFileWithDigest(
  stream: NodeJS.ReadableStream,
  targetFilePath: string
): Promise<Sha256Digest> {
  const hasher = createHashStream()
  await pipeline(stream, hasher, fsSync.createWriteStream(targetFilePath))
  return hasher.result().digest
}

async function extractZipFile(
  zipFilePath: string,
  destinationDir: string
): Promise<void> {
  const resolvedDest = path.resolve(destinationDir)
  await fs.mkdir(resolvedDest, {recursive: true})

  const zipFile = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(
      zipFilePath,
      {lazyEntries: true, decodeStrings: true},
      (err, file) => {
        if (err || !file) {
          if (
            err &&
            (err.message.startsWith('invalid relative path:') ||
              err.message.startsWith('absolute path:'))
          ) {
            reject(new ZipSlipError(err.message))
            return
          }
          reject(err ?? new Error('Failed to open zip archive'))
          return
        }
        resolve(file)
      }
    )
  })

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const fail = (err: unknown): void => {
        if (settled) {
          return
        }
        settled = true
        zipFile.close()
        if (
          err instanceof Error &&
          (err.message.startsWith('invalid relative path:') ||
            err.message.startsWith('absolute path:'))
        ) {
          reject(new ZipSlipError(err.message))
          return
        }
        reject(err instanceof Error ? err : new Error(String(err)))
      }

      zipFile.on('error', fail)
      zipFile.on('end', () => {
        if (!settled) {
          settled = true
          resolve()
        }
      })

      zipFile.on('entry', (entry: yauzl.Entry) => {
        void (async () => {
          const targetPath = resolveSafeEntryPath(resolvedDest, entry.fileName)
          if (entry.fileName.endsWith('/')) {
            await fs.mkdir(targetPath, {recursive: true})
            zipFile.readEntry()
            return
          }

          await fs.mkdir(path.dirname(targetPath), {recursive: true})
          const entryStream = await new Promise<NodeJS.ReadableStream>(
            (resStream, rejStream) => {
              zipFile.openReadStream(entry, (openErr, readStream) => {
                if (openErr || !readStream) {
                  rejStream(
                    openErr ?? new Error(`Failed reading zip entry ${entry.fileName}`)
                  )
                  return
                }
                resStream(readStream)
              })
            }
          )

          const stagePath = makeTempFilePath(
            path.dirname(targetPath),
            '.s3-artifact-entry'
          )
          try {
            await pipeline(entryStream, fsSync.createWriteStream(stagePath))
            await fs.rename(stagePath, targetPath)
          } catch (extractErr) {
            await fs.rm(stagePath, {force: true}).catch(() => undefined)
            throw extractErr
          }
          zipFile.readEntry()
        })().catch(fail)
      })

      zipFile.readEntry()
    })
  } finally {
    zipFile.close()
  }
}

export async function extractArchiveStream(
  input: Buffer | NodeJS.ReadableStream,
  destinationDir: string
): Promise<void> {
  const tempZipPath = makeTempFilePath(os.tmpdir(), '.s3-artifact-zip')
  try {
    const source = Buffer.isBuffer(input) ? Readable.from(input) : input
    await pipeline(source, fsSync.createWriteStream(tempZipPath))
    await extractZipFile(tempZipPath, destinationDir)
  } finally {
    await fs.rm(tempZipPath, {force: true}).catch(() => undefined)
  }
}

export async function verifyDigestAndMaterialize(
  opts: MaterializeOptions
): Promise<MaterializeResult> {
  const resolvedDest = path.resolve(opts.destinationDir)
  await fs.mkdir(resolvedDest, {recursive: true})

  if (!opts.archived || opts.skipDecompress) {
    const safeFileName = path.basename(opts.rawFileName)
    const targetPath = resolveSafeEntryPath(resolvedDest, safeFileName)
    const stagePath = makeTempFilePath(resolvedDest, '.s3-artifact-stage')

    try {
      const actualDigest = await spoolStreamToFileWithDigest(
        opts.stream,
        stagePath
      )
      const digestMismatch = actualDigest !== opts.expectedDigest
      if (digestMismatch && opts.abortOnDigestMismatch) {
        await fs.rm(stagePath, {force: true})
        return {actualDigest, digestMismatch}
      }

      await fs.rename(stagePath, targetPath)
      return {actualDigest, digestMismatch}
    } catch (error) {
      await fs.rm(stagePath, {force: true}).catch(() => undefined)
      throw error
    }
  }

  const tempZipPath = makeTempFilePath(os.tmpdir(), '.s3-artifact-dl')
  try {
    const actualDigest = await spoolStreamToFileWithDigest(
      opts.stream,
      tempZipPath
    )
    const digestMismatch = actualDigest !== opts.expectedDigest
    core.debug(
      `Verified zip stream digest=${actualDigest}, expected=${opts.expectedDigest}, mismatch=${String(digestMismatch)}`
    )
    if (digestMismatch && opts.abortOnDigestMismatch) {
      return {actualDigest, digestMismatch}
    }

    await extractZipFile(tempZipPath, resolvedDest)
    return {actualDigest, digestMismatch}
  } finally {
    await fs.rm(tempZipPath, {force: true}).catch(() => undefined)
  }
}
