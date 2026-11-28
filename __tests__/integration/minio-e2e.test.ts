import {afterAll, beforeAll, describe, expect, it} from 'vitest'
import {CreateBucketCommand, GetObjectTaggingCommand, HeadBucketCommand, S3Client} from '@aws-sdk/client-s3'
import {execFileSync, spawn, spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {parseGitHubOutputFile} from '../helpers/action-harness.js'

const CONTAINER_IMAGE = 'cgr.dev/chainguard/minio:latest'
const BUCKET = 'ci-artifacts-e2e'
const ACCESS_KEY = 'minioadmin'
const SECRET_KEY = 'minioadmin'

function runChildBundle(
  bundlePath: string,
  env: Record<string, string>,
  cwd: string
): Promise<{readonly code: number; readonly stdout: string; readonly stderr: string}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundlePath], {
      cwd,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: env.HOME ?? os.tmpdir(),
        ...env
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', code => {
      resolve({code: code ?? 1, stdout, stderr})
    })
  })
}

async function waitForMinio(endpoint: string, s3: S3Client): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const res = await fetch(`${endpoint}/minio/health/live`).catch(() => null)
    if (res?.ok) {
      const exists = await s3
        .send(new HeadBucketCommand({Bucket: BUCKET}))
        .then(() => true)
        .catch(() => false)
      if (!exists) {
        await s3.send(new CreateBucketCommand({Bucket: BUCKET}))
      }
      return
    }
    await new Promise(r => setTimeout(r, 300))
  }
  throw new Error(`MinIO did not become healthy at ${endpoint} within 30s`)
}

describe('Live MinIO S3 Docker E2E with bundled dist/upload & dist/download', () => {
  let containerId = ''
  let endpoint = ''
  let s3: S3Client
  let workspace: string
  const repoRoot = path.resolve(import.meta.dirname, '../..')

  beforeAll(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 's3-art-minio-e2e-'))
    const containerName = `s3-artifact-minio-${process.pid}-${Date.now()}`
    containerId = execFileSync(
      'docker',
      [
        'run',
        '-d',
        '--rm',
        '--name',
        containerName,
        '-p',
        '127.0.0.1:0:9000',
        '-e',
        `MINIO_ROOT_USER=${ACCESS_KEY}`,
        '-e',
        `MINIO_ROOT_PASSWORD=${SECRET_KEY}`,
        CONTAINER_IMAGE,
        'server',
        '/data'
      ],
      {encoding: 'utf8'}
    ).trim()

    const portOutput = execFileSync(
      'docker',
      ['port', containerId, '9000/tcp'],
      {encoding: 'utf8'}
    ).trim()
    const hostPort = portOutput.split('\n')[0]!.trim()
    endpoint = `http://${hostPort}`

    s3 = new S3Client({
      region: 'us-east-1',
      endpoint,
      forcePathStyle: true,
      credentials: {accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY},
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED'
    })

    await waitForMinio(endpoint, s3)
  }, 60_000)

  afterAll(async () => {
    if (containerId) {
      spawnSync('docker', ['stop', '-t', '2', containerId], {stdio: 'ignore'})
    }
    if (workspace) {
      await fs.rm(workspace, {recursive: true, force: true})
    }
  })

  it('executes standalone dist/upload, dist/download, and dist/merge against live MinIO without node_modules', async () => {
    const isolatedDist = path.join(workspace, 'isolated-action/dist')
    await fs.cp(path.join(repoRoot, 'dist'), isolatedDist, {recursive: true})
    const uploadBundle = path.join(isolatedDist, 'upload/index.js')
    const downloadBundle = path.join(isolatedDist, 'download/index.js')
    const mergeBundle = path.join(isolatedDist, 'merge/index.js')
    const outFile = path.join(workspace, 'github_output.txt')
    await fs.writeFile(outFile, '', 'utf8')

    await fs.mkdir(path.join(workspace, 'artifacts/sub'), {recursive: true})
    const bigPayload = Buffer.alloc(9 * 1024 * 1024 + 1234, 0x61)
    await fs.writeFile(path.join(workspace, 'artifacts/big.bin'), bigPayload)
    await fs.writeFile(path.join(workspace, 'artifacts/sub/hello.txt'), 'minio-e2e-ok')

    const commonEnv: Record<string, string> = {
      GITHUB_WORKSPACE: workspace,
      GITHUB_REPOSITORY: 'e2e/repo',
      GITHUB_RUN_ID: '4242',
      GITHUB_RUN_ATTEMPT: '1',
      GITHUB_OUTPUT: outFile,
      S3_ARTIFACT_BUCKET: BUCKET,
      S3_ARTIFACT_KEY_PREFIX: 'actions-e2e',
      S3_ARTIFACT_ENDPOINT: endpoint,
      S3_ARTIFACT_REGION: 'us-east-1',
      S3_ARTIFACT_FORCE_PATH_STYLE: 'true',
      AWS_ACCESS_KEY_ID: ACCESS_KEY,
      AWS_SECRET_ACCESS_KEY: SECRET_KEY
    }

    const upRes = await runChildBundle(
      uploadBundle,
      {
        ...commonEnv,
        INPUT_NAME: 'bundle-e2e',
        INPUT_PATH: 'artifacts/**',
        'INPUT_COMPRESSION-LEVEL': '0',
        'INPUT_RETENTION-DAYS': '7'
      },
      workspace
    )
    expect(upRes.code, upRes.stdout + upRes.stderr).toBe(0)
    const upOutputs = parseGitHubOutputFile(await fs.readFile(outFile, 'utf8'))
    expect(upOutputs['artifact-id']).toMatch(/^\d+$/)
    expect(upOutputs['artifact-digest']).toMatch(/^[0-9a-f]{64}$/)
    expect(upOutputs['artifact-url']).toBe(
      `s3://${BUCKET}/actions-e2e/e2e/repo/runs/4242/blobs/${upOutputs['artifact-id']}`
    )

    const blobTags = await s3.send(
      new GetObjectTaggingCommand({
        Bucket: BUCKET,
        Key: `actions-e2e/e2e/repo/runs/4242/blobs/${upOutputs['artifact-id']}`
      })
    )
    expect(blobTags.TagSet).toEqual([
      {Key: 's3-artifact-retention-days', Value: '7'}
    ])

    const dupRes = await runChildBundle(
      uploadBundle,
      {
        ...commonEnv,
        INPUT_NAME: 'bundle-e2e',
        INPUT_PATH: 'artifacts/sub/hello.txt',
        INPUT_OVERWRITE: 'false'
      },
      workspace
    )
    expect(dupRes.code).toBe(1)

    await fs.writeFile(path.join(workspace, 'artifacts/sub/hello.txt'), 'minio-e2e-attempt2')
    await fs.writeFile(outFile, '', 'utf8')
    const rerunRes = await runChildBundle(
      uploadBundle,
      {
        ...commonEnv,
        GITHUB_RUN_ATTEMPT: '2',
        INPUT_NAME: 'bundle-e2e',
        INPUT_PATH: 'artifacts/sub/hello.txt',
        INPUT_OVERWRITE: 'false'
      },
      workspace
    )
    expect(rerunRes.code, rerunRes.stdout + rerunRes.stderr).toBe(0)

    await fs.writeFile(path.join(workspace, 'raw.tar.gz'), 'raw-archive-content')
    await fs.writeFile(outFile, '', 'utf8')
    const rawUp = await runChildBundle(
      uploadBundle,
      {
        ...commonEnv,
        INPUT_NAME: 'ignored',
        INPUT_PATH: 'raw.tar.gz',
        INPUT_ARCHIVE: 'false'
      },
      workspace
    )
    expect(rawUp.code, rawUp.stdout + rawUp.stderr).toBe(0)
    const rawOut = parseGitHubOutputFile(await fs.readFile(outFile, 'utf8'))

    const dlDest = path.join(workspace, 'downloaded-split')
    await fs.writeFile(outFile, '', 'utf8')
    const dlAll = await runChildBundle(
      downloadBundle,
      {
        ...commonEnv,
        INPUT_PATH: dlDest,
        'INPUT_MERGE-MULTIPLE': 'false'
      },
      workspace
    )
    expect(dlAll.code, dlAll.stdout + dlAll.stderr).toBe(0)
    const dlOut = parseGitHubOutputFile(await fs.readFile(outFile, 'utf8'))
    expect(dlOut['download-path']).toBe(dlDest)
    expect(await fs.readFile(path.join(dlDest, 'bundle-e2e/hello.txt'), 'utf8')).toBe(
      'minio-e2e-attempt2'
    )
    expect(await fs.readFile(path.join(dlDest, 'raw.tar.gz/raw.tar.gz'), 'utf8')).toBe(
      'raw-archive-content'
    )

    const dlByIdDest = path.join(workspace, 'downloaded-by-id')
    const dlById = await runChildBundle(
      downloadBundle,
      {
        ...commonEnv,
        'INPUT_ARTIFACT-IDS': rawOut['artifact-id']!,
        INPUT_PATH: dlByIdDest
      },
      workspace
    )
    expect(dlById.code, dlById.stdout + dlById.stderr).toBe(0)
    expect(await fs.readFile(path.join(dlByIdDest, 'raw.tar.gz'), 'utf8')).toBe(
      'raw-archive-content'
    )

    const cappedDest = path.join(workspace, 'downloaded-capped')
    const dlCapped = await runChildBundle(
      downloadBundle,
      {
        ...commonEnv,
        ACTIONS_ARTIFACT_MAX_ARTIFACT_COUNT: '1',
        INPUT_PATH: cappedDest
      },
      workspace
    )
    expect(dlCapped.code, dlCapped.stdout + dlCapped.stderr).toBe(0)
    expect(dlCapped.stdout).toContain('Artifact list exceeded the limit of 1')
    expect(await fs.readFile(path.join(cappedDest, 'hello.txt'), 'utf8')).toBe(
      'minio-e2e-attempt2'
    )
    await expect(fs.access(path.join(cappedDest, 'raw.tar.gz'))).rejects.toThrow()

    await fs.writeFile(path.join(workspace, 'part-a.txt'), 'left-side')
    await fs.writeFile(path.join(workspace, 'part-b.txt'), 'right-side')
    expect(
      (
        await runChildBundle(
          uploadBundle,
          {
            ...commonEnv,
            INPUT_NAME: 'merge-left',
            INPUT_PATH: 'part-a.txt'
          },
          workspace
        )
      ).code
    ).toBe(0)
    expect(
      (
        await runChildBundle(
          uploadBundle,
          {
            ...commonEnv,
            INPUT_NAME: 'merge-right',
            INPUT_PATH: 'part-b.txt'
          },
          workspace
        )
      ).code
    ).toBe(0)

    await fs.writeFile(outFile, '', 'utf8')
    const mergeRes = await runChildBundle(
      mergeBundle,
      {
        ...commonEnv,
        INPUT_NAME: 'merged-parts',
        INPUT_PATTERN: 'merge-*',
        'INPUT_SEPARATE-DIRECTORIES': 'true',
        'INPUT_DELETE-MERGED': 'true',
        'INPUT_ARTIFACT-URL-FORMAT': 'presigned',
        'INPUT_PRESIGN-EXPIRES-SECONDS': '300'
      },
      workspace
    )
    expect(mergeRes.code, mergeRes.stdout + mergeRes.stderr).toBe(0)
    const mergeOut = parseGitHubOutputFile(await fs.readFile(outFile, 'utf8'))
    expect(mergeOut['artifact-url']).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//)
    const signedRes = await fetch(mergeOut['artifact-url']!)
    expect(signedRes.ok).toBe(true)
    const signedBytes = Buffer.from(await signedRes.arrayBuffer())
    const signedDigest = createHash('sha256').update(signedBytes).digest('hex')
    expect(signedDigest).toBe(mergeOut['artifact-digest'])

    const deletedSourceDl = await runChildBundle(
      downloadBundle,
      {
        ...commonEnv,
        INPUT_NAME: 'merge-left',
        INPUT_PATH: path.join(workspace, 'deleted-left')
      },
      workspace
    )
    expect(deletedSourceDl.code).toBe(1)

    const mergedDlDest = path.join(workspace, 'downloaded-merged')
    const mergedDl = await runChildBundle(
      downloadBundle,
      {
        ...commonEnv,
        INPUT_NAME: 'merged-parts',
        INPUT_PATH: mergedDlDest
      },
      workspace
    )
    expect(mergedDl.code, mergedDl.stdout + mergedDl.stderr).toBe(0)
    expect(
      await fs.readFile(path.join(mergedDlDest, 'merge-left/part-a.txt'), 'utf8')
    ).toBe('left-side')
    expect(
      await fs.readFile(path.join(mergedDlDest, 'merge-right/part-b.txt'), 'utf8')
    ).toBe('right-side')
  }, 60_000)
})
