import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {runActionBoundary} from '../helpers/action-harness.js'
import {parseBucketName} from '../../src/shared/types.js'
import {InMemoryArtifactStore} from '../../src/storage/memory-store.js'
import {runUploadAction} from '../../src/upload/action.js'

describe('presigned artifact-url', () => {
  let workspace: string
  let store: InMemoryArtifactStore

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 's3-art-presign-'))
    store = new InMemoryArtifactStore(parseBucketName('presign-bucket'), 'ci')
    store.presignGetObject = (blobKey: string) =>
      Promise.resolve(`https://signed.example/${blobKey}?X-Amz-Expires=120`)
  })

  afterEach(async () => {
    await fs.rm(workspace, {recursive: true, force: true})
  })

  const env = () => ({
    S3_ARTIFACT_BUCKET: 'presign-bucket',
    S3_ARTIFACT_KEY_PREFIX: 'ci',
    GITHUB_WORKSPACE: workspace,
    GITHUB_REPOSITORY: 'org/app',
    GITHUB_RUN_ID: '500',
    GITHUB_RUN_ATTEMPT: '1'
  })

  it('keeps s3:// unless artifact-url-format is presigned', async () => {
    await fs.writeFile(path.join(workspace, 'app.txt'), 'hello')
    const plain = await runActionBoundary({
      cwd: workspace,
      env: env(),
      inputs: {name: 'plain', path: 'app.txt'},
      run: () => runUploadAction({createStore: () => store})
    })
    expect(plain.exitCode).toBe(0)
    expect(plain.outputs['artifact-url']).toMatch(/^s3:\/\/presign-bucket\//)

    await fs.writeFile(path.join(workspace, 'app2.txt'), 'hello')
    const signed = await runActionBoundary({
      cwd: workspace,
      env: env(),
      inputs: {
        name: 'signed',
        path: 'app2.txt',
        'artifact-url-format': 'presigned',
        'presign-expires-seconds': '120'
      },
      run: () => runUploadAction({createStore: () => store})
    })
    expect(signed.exitCode).toBe(0)
    expect(signed.outputs['artifact-url']).toMatch(
      /^https:\/\/signed\.example\/ci\/org\/app\/runs\/500\/blobs\/\d+\?X-Amz-Expires=120$/
    )
  })

  it('rejects an unknown format and an out-of-range expiry', async () => {
    await fs.writeFile(path.join(workspace, 'app.txt'), 'hello')
    const format = await runActionBoundary({
      cwd: workspace,
      env: env(),
      inputs: {name: 'bad-format', path: 'app.txt', 'artifact-url-format': 'https'},
      run: () => runUploadAction({createStore: () => store})
    })
    expect(format.exitCode).not.toBe(0)
    expect(`${format.stdout}\n${format.stderr}`).toContain('artifact-url-format')

    const expiry = await runActionBoundary({
      cwd: workspace,
      env: {...env(), S3_ARTIFACT_PRESIGN_EXPIRES_SECONDS: '0'},
      inputs: {name: 'bad-expiry', path: 'app.txt', 'artifact-url-format': 'presigned'},
      run: () => runUploadAction({createStore: () => store})
    })
    expect(expiry.exitCode).not.toBe(0)
    expect(`${expiry.stdout}\n${expiry.stderr}`).toContain('presign-expires-seconds')
  })

  it('honors env fallbacks and treats empty env vars as unset', async () => {
    await fs.writeFile(path.join(workspace, 'env.txt'), 'hello')
    let capturedExpires: number | undefined
    store.presignGetObject = (blobKey: string, expiresInSeconds: number) => {
      capturedExpires = expiresInSeconds
      return Promise.resolve(
        `https://signed.example/${blobKey}?X-Amz-Expires=${expiresInSeconds}`
      )
    }

    const fromEnv = await runActionBoundary({
      cwd: workspace,
      env: {
        ...env(),
        S3_ARTIFACT_URL_FORMAT: ' presigned ',
        S3_ARTIFACT_PRESIGN_EXPIRES_SECONDS: ' 300 '
      },
      inputs: {name: 'env-signed', path: 'env.txt'},
      run: () => runUploadAction({createStore: () => store})
    })
    expect(fromEnv.exitCode).toBe(0)
    expect(capturedExpires).toBe(300)
    expect(fromEnv.outputs['artifact-url']).toMatch(
      /^https:\/\/signed\.example\/ci\/org\/app\/runs\/500\/blobs\/\d+\?X-Amz-Expires=300$/
    )

    const emptyEnv = await runActionBoundary({
      cwd: workspace,
      env: {
        ...env(),
        S3_ARTIFACT_URL_FORMAT: '',
        S3_ARTIFACT_PRESIGN_EXPIRES_SECONDS: '   '
      },
      inputs: {name: 'empty-env', path: 'env.txt'},
      run: () => runUploadAction({createStore: () => store})
    })
    expect(emptyEnv.exitCode).toBe(0)
    expect(emptyEnv.outputs['artifact-url']).toMatch(/^s3:\/\/presign-bucket\//)
  })
})
