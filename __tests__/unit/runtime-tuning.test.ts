import {describe, expect, it} from 'vitest'
import {Readable} from 'node:stream'
import * as os from 'node:os'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {ArtifactNotFoundError} from '../../src/shared/errors.js'
import {
  withBlobReadRetry,
  watchUploadStall,
  withChunkInactivityTimeout
} from '../../src/shared/blob-transfer.js'
import {
  concurrencyCapForCpu,
  getConcurrency,
  getMaxArtifactListCount,
  getUploadChunkTimeout
} from '../../src/shared/runtime-config.js'
import {parseBucketName, parseRunScope} from '../../src/shared/types.js'
import {InMemoryArtifactStore} from '../../src/storage/memory-store.js'
import {runActionBoundary} from '../helpers/action-harness.js'
import {runUploadAction} from '../../src/upload/action.js'

describe('artifact runtime tuning', () => {
  it('defaults upload concurrency to 5 and caps an override by CPU count', () => {
    expect(getConcurrency({})).toBe(5)
    const cap = concurrencyCapForCpu(os.cpus().length)
    expect(getConcurrency({ACTIONS_ARTIFACT_UPLOAD_CONCURRENCY: '2'})).toBe(2)
    expect(
      getConcurrency({ACTIONS_ARTIFACT_UPLOAD_CONCURRENCY: String(cap + 50)})
    ).toBe(cap)
    expect(concurrencyCapForCpu(2)).toBe(32)
    expect(concurrencyCapForCpu(8)).toBe(128)
    expect(concurrencyCapForCpu(32)).toBe(300)
    expect(() =>
      getConcurrency({ACTIONS_ARTIFACT_UPLOAD_CONCURRENCY: '0'})
    ).toThrow('Invalid value set for ACTIONS_ARTIFACT_UPLOAD_CONCURRENCY')
    expect(() =>
      getConcurrency({ACTIONS_ARTIFACT_UPLOAD_CONCURRENCY: '3xyz'})
    ).toThrow('Invalid value set for ACTIONS_ARTIFACT_UPLOAD_CONCURRENCY')
  })

  it('reads the upload stall timeout and the list cap', () => {
    expect(getUploadChunkTimeout({})).toBe(300000)
    expect(getUploadChunkTimeout({ACTIONS_ARTIFACT_UPLOAD_TIMEOUT_MS: '1500'})).toBe(
      1500
    )
    expect(() =>
      getUploadChunkTimeout({ACTIONS_ARTIFACT_UPLOAD_TIMEOUT_MS: 'nope'})
    ).toThrow('Invalid value set for ACTIONS_ARTIFACT_UPLOAD_TIMEOUT_MS')
    expect(() =>
      getUploadChunkTimeout({ACTIONS_ARTIFACT_UPLOAD_TIMEOUT_MS: '0'})
    ).toThrow('Invalid value set for ACTIONS_ARTIFACT_UPLOAD_TIMEOUT_MS')
    expect(() =>
      getUploadChunkTimeout({ACTIONS_ARTIFACT_UPLOAD_TIMEOUT_MS: '-5'})
    ).toThrow('Invalid value set for ACTIONS_ARTIFACT_UPLOAD_TIMEOUT_MS')
    expect(getMaxArtifactListCount({})).toBe(1000)
    expect(getMaxArtifactListCount({ACTIONS_ARTIFACT_MAX_ARTIFACT_COUNT: '2'})).toBe(2)
    expect(() =>
      getMaxArtifactListCount({ACTIONS_ARTIFACT_MAX_ARTIFACT_COUNT: '0'})
    ).toThrow('Invalid value set for ACTIONS_ARTIFACT_MAX_ARTIFACT_COUNT')
  })

  it('rejects a stalled upload at the timeout boundary and ignores the watcher after abort', async () => {
    const stalled = watchUploadStall({
      timeoutMs: 20,
      signal: new AbortController().signal,
      lastProgressMs: () => 0,
      now: () => 20
    })
    await expect(stalled).rejects.toThrow('Upload progress stalled.')

    const abort = new AbortController()
    let last = 0
    const live = watchUploadStall({
      timeoutMs: 30,
      signal: abort.signal,
      lastProgressMs: () => last,
      now: () => last
    })
    last = 0
    abort.abort()
    await live
  })

  it('retries a blob read with backoff, skips sleep on final failure, and does not retry a missing artifact', async () => {
    let opens = 0
    const sleeps: number[] = []
    const body = await withBlobReadRetry(
      () => {
        opens += 1
        if (opens < 3) {
          return Promise.reject(new Error('reset'))
        }
        return Promise.resolve(Readable.from(['ok']))
      },
      async stream => {
        const chunks: Buffer[] = []
        for await (const chunk of stream) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        }
        return Buffer.concat(chunks).toString()
      },
      {
        backoffMs: 5000,
        chunkTimeoutMs: 1000,
        sleep: ms => {
          sleeps.push(ms)
          return Promise.resolve()
        }
      }
    )
    expect(body).toBe('ok')
    expect(opens).toBe(3)
    expect(sleeps).toEqual([5000, 5000])

    const failSleeps: number[] = []
    await expect(
      withBlobReadRetry(
        () => Promise.reject(new Error('transient')),
        () => Promise.resolve('x'),
        {
          maxAttempts: 3,
          backoffMs: 5000,
          sleep: ms => {
            failSleeps.push(ms)
            return Promise.resolve()
          }
        }
      )
    ).rejects.toThrow('Artifact download failed after 3 attempts.')
    expect(failSleeps).toEqual([5000, 5000])

    const hung = new Readable({
      read() {
        return undefined
      }
    })
    const wrapped = withChunkInactivityTimeout(hung, 30)
    await expect(
      new Promise((resolve, reject) => {
        wrapped.on('error', reject)
        wrapped.on('end', resolve)
      })
    ).rejects.toThrow('Blob storage chunk did not respond in 30ms')

    await expect(
      withBlobReadRetry(
        () => Promise.reject(new ArtifactNotFoundError('missing')),
        () => Promise.resolve('x'),
        {
          sleep: () => Promise.reject(new Error('should not sleep'))
        }
      )
    ).rejects.toThrow('missing')
  })

  it('returns only the first N manifests when the list cap is set', async () => {
    const previous = process.env.ACTIONS_ARTIFACT_MAX_ARTIFACT_COUNT
    process.env.ACTIONS_ARTIFACT_MAX_ARTIFACT_COUNT = '1'
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 's3-art-cap-'))
    const store = new InMemoryArtifactStore(parseBucketName('cap-bucket'), 'ci')
    try {
      for (const name of ['side-a', 'side-b']) {
        const file = path.join(workspace, `${name}.txt`)
        await fs.writeFile(file, name)
        const up = await runActionBoundary({
          cwd: workspace,
          env: {
            S3_ARTIFACT_BUCKET: 'cap-bucket',
            S3_ARTIFACT_KEY_PREFIX: 'ci',
            GITHUB_WORKSPACE: workspace,
            GITHUB_REPOSITORY: 'org/app',
            GITHUB_RUN_ID: '500',
            GITHUB_RUN_ATTEMPT: '1',
            ACTIONS_ARTIFACT_MAX_ARTIFACT_COUNT: '1'
          },
          inputs: {name, path: `${name}.txt`},
          run: () => runUploadAction({createStore: () => store})
        })
        expect(up.exitCode).toBe(0)
      }
      const listed = await store.listManifests(
        parseRunScope({repository: 'org/app', runId: '500', runAttempt: '1'})
      )
      expect(listed.map(item => item.name)).toEqual(['side-a'])
    } finally {
      if (previous === undefined) {
        delete process.env.ACTIONS_ARTIFACT_MAX_ARTIFACT_COUNT
      } else {
        process.env.ACTIONS_ARTIFACT_MAX_ARTIFACT_COUNT = previous
      }
      await fs.rm(workspace, {recursive: true, force: true})
    }
  })
})
