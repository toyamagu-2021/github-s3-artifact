import * as core from '@actions/core'
import {type Readable, Transform} from 'node:stream'
import {
  ArtifactNotFoundError,
  ArtifactValidationError,
  DigestMismatchError,
  ZipSlipError
} from './errors.js'

export const DOWNLOAD_MAX_ATTEMPTS = 5
export const DOWNLOAD_RETRY_BACKOFF_MS = 5000
export const DOWNLOAD_CHUNK_TIMEOUT_MS = 30 * 1000

export interface BlobReadRetryOptions {
  readonly maxAttempts?: number
  readonly backoffMs?: number
  readonly chunkTimeoutMs?: number
  readonly sleep?: (ms: number) => Promise<void>
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms)
  })
}

export function isRetryableBlobError(error: unknown): boolean {
  return !(
    error instanceof ZipSlipError ||
    error instanceof ArtifactValidationError ||
    error instanceof ArtifactNotFoundError ||
    error instanceof DigestMismatchError
  )
}

export function withChunkInactivityTimeout(
  source: Readable,
  timeoutMs: number
): Readable {
  const pass = new Transform({
    transform(chunk, _encoding, callback) {
      timer.refresh()
      callback(null, chunk)
    }
  })
  const clear = (): void => {
    clearTimeout(timer)
  }
  const fail = (): void => {
    clear()
    const timeoutError = new Error(
      `Blob storage chunk did not respond in ${timeoutMs}ms`
    )
    if (typeof source.destroy === 'function') {
      source.destroy(timeoutError)
    }
    pass.destroy(timeoutError)
  }
  const timer = setTimeout(fail, timeoutMs)
  pass.on('end', clear)
  pass.on('close', clear)
  pass.on('error', clear)
  source.on('error', error => {
    clear()
    if (!pass.destroyed) {
      pass.destroy(error)
    }
  })
  source.pipe(pass)
  return pass
}

export function watchUploadStall(opts: {
  readonly timeoutMs: number
  readonly signal: AbortSignal
  readonly lastProgressMs: () => number
  readonly now?: () => number
}): Promise<void> {
  const now = opts.now ?? (() => Date.now())
  const pollMs = Math.max(1, Math.min(opts.timeoutMs, 5000))
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      if (now() - opts.lastProgressMs() >= opts.timeoutMs) {
        clearInterval(timer)
        reject(new Error('Upload progress stalled.'))
      }
    }, pollMs)

    const onAbort = (): void => {
      clearInterval(timer)
      resolve()
    }
    if (opts.signal.aborted) {
      onAbort()
      return
    }
    opts.signal.addEventListener('abort', onAbort, {once: true})
  })
}

export async function withBlobReadRetry<T>(
  open: () => Promise<NodeJS.ReadableStream>,
  use: (stream: NodeJS.ReadableStream) => Promise<T>,
  options: BlobReadRetryOptions = {}
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? DOWNLOAD_MAX_ATTEMPTS
  const backoffMs = options.backoffMs ?? DOWNLOAD_RETRY_BACKOFF_MS
  const chunkTimeoutMs = options.chunkTimeoutMs ?? DOWNLOAD_CHUNK_TIMEOUT_MS
  const sleep = options.sleep ?? defaultSleep
  let attempt = 0
  let lastError: unknown

  while (attempt < maxAttempts) {
    try {
      const stream = withChunkInactivityTimeout(
        (await open()) as Readable,
        chunkTimeoutMs
      )
      return await use(stream)
    } catch (error) {
      if (!isRetryableBlobError(error)) {
        throw error
      }
      lastError = error
      attempt += 1
      if (attempt < maxAttempts) {
        core.debug(
          `Failed to download artifact on attempt ${attempt}/${maxAttempts} due to ${error instanceof Error ? error.message : String(error)}. Retrying in ${backoffMs}ms...`
        )
        await sleep(backoffMs)
      }
    }
  }

  const message = `Artifact download failed after ${attempt} attempts.`
  if (lastError instanceof Error) {
    throw new Error(message, {cause: lastError})
  }
  throw new Error(message)
}
