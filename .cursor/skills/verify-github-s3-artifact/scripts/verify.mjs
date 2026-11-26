#!/usr/bin/env node

import {createHash} from 'node:crypto'
import {execFile, execFileSync, spawn} from 'node:child_process'
import {existsSync, readdirSync} from 'node:fs'
import * as fs from 'node:fs/promises'
import * as net from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import {promisify} from 'node:util'

const execFileAsync = promisify(execFile)

const MINIO_VERSION = 'RELEASE.2025-09-07T16-13-09Z'
const MINIO_URL = `https://github.com/minio/minio/releases/download/${MINIO_VERSION}/minio.linux-amd64.${MINIO_VERSION}`
const MINIO_SHA256 = '7c5bd8512c6e966455b1d198209358b2d191c77a83ab377c4073281065fb855f'
const ACCESS_KEY = 'minioadmin'
const SECRET_KEY = 'minioadmin'
const BUCKET = 'verify-artifacts'
const KEY_PREFIX = 'verify'
const REPOSITORY = 'verify-org/verify-repo'
const HELLO_BODY = 'hello from verify\n'
const RAW_BODY = 'raw-payload\n'

const repoRoot = path.resolve(import.meta.dirname, '../../../..')
const evidenceRoot = path.join(repoRoot, '.cursor/skills/verify-github-s3-artifact/evidence/runs')
const runtimeRoot = path.join(os.tmpdir(), 'verify-github-s3-artifact')
const currentPointer = path.join(runtimeRoot, 'current')

function usage() {
  return [
    'Usage: node .cursor/skills/verify-github-s3-artifact/scripts/verify.mjs <command> [feature] [--state path]',
    'Commands: launch, doctor, drive <feature>, cleanup',
    'Features: upload-archive, upload-raw, download-by-name, reject-duplicate, no-files, artifact-list-cap, presigned-url, merge-artifacts'
  ].join('\n')
}

function parseArgs(argv) {
  const args = argv.slice(2)
  const command = args[0]
  let feature
  let statePath
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--state') {
      statePath = args[++i]
      if (!statePath) {
        throw new Error('--state requires a path')
      }
    } else if (!feature) {
      feature = arg
    } else {
      throw new Error(`Unexpected argument: ${arg}`)
    }
  }
  return {command, feature, statePath}
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

async function sha256File(filePath) {
  const data = await fs.readFile(filePath)
  return sha256(data)
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message)
  }
}

function parseGitHubOutput(content) {
  const outputs = {}
  const lines = content.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (!line) {
      continue
    }
    const eqIndex = line.indexOf('=')
    const delimIndex = line.indexOf('<<')
    if (delimIndex > 0 && (eqIndex === -1 || delimIndex < eqIndex)) {
      const key = line.slice(0, delimIndex)
      const delimiter = line.slice(delimIndex + 2)
      const valueLines = []
      for (i = i + 1; i < lines.length; i++) {
        const inner = lines[i] ?? ''
        if (inner === delimiter) {
          break
        }
        valueLines.push(inner)
      }
      outputs[key] = valueLines.join('\n')
    } else if (eqIndex > 0) {
      outputs[line.slice(0, eqIndex)] = line.slice(eqIndex + 1)
    }
  }
  return outputs
}

function inputEnv(inputs) {
  const env = {}
  for (const [key, value] of Object.entries(inputs)) {
    env[`INPUT_${key.replace(/ /g, '_').toUpperCase()}`] = value
  }
  return env
}

function manifestKey(state, name) {
  const [owner, repo] = state.repository.split('/')
  return `${state.keyPrefix}/${owner}/${repo}/runs/${state.githubRunId}/manifests/${encodeURIComponent(name)}.json`
}

function isNotFound(error) {
  const status = error?.$metadata?.httpStatusCode
  const name = error?.name || error?.Code || error?.code
  return status === 404 || name === 'NotFound' || name === 'NoSuchKey'
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function sleep(ms) {
  await new Promise(resolve => setTimeout(resolve, ms))
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

async function listeners(port) {
  try {
    const {stdout} = await execFileAsync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], {
      encoding: 'utf8'
    })
    return stdout
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
  } catch (error) {
    if (error && error.code === 1) {
      return []
    }
    throw error
  }
}

function findNodeBin() {
  if (process.env.VERIFY_NODE) {
    return process.env.VERIFY_NODE
  }
  const major = Number(process.versions.node.split('.')[0])
  if (major >= 24) {
    return process.execPath
  }
  const root = path.join(os.homedir(), '.nvm/versions/node')
  if (!existsSync(root)) {
    return process.execPath
  }
  const names = readdirSync(root).filter(name => name.startsWith('v24.'))
  names.sort()
  const latest = names[names.length - 1]
  if (!latest) {
    return process.execPath
  }
  const bin = path.join(root, latest, 'bin/node')
  return existsSync(bin) ? bin : process.execPath
}

function execFileSyncVersion(nodeBin) {
  return execFileSync(nodeBin, ['-p', 'process.version'], {encoding: 'utf8'}).trim()
}

async function loadS3() {
  try {
    return await import('@aws-sdk/client-s3')
  } catch {
    throw new Error('Cannot load @aws-sdk/client-s3. From the repo root, run npm ci.')
  }
}

function s3Client(S3Client, state) {
  return new S3Client({
    region: 'us-east-1',
    endpoint: state.endpoint,
    forcePathStyle: true,
    credentials: {
      accessKeyId: state.accessKey,
      secretAccessKey: state.secretKey
    },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED'
  })
}

async function ensureMinio() {
  if (process.env.MINIO_BIN && existsSync(process.env.MINIO_BIN)) {
    return process.env.MINIO_BIN
  }
  const dest = path.join(os.homedir(), '.cache/verify-github-s3-artifact/minio')
  await fs.mkdir(path.dirname(dest), {recursive: true})
  if (existsSync(dest)) {
    const current = await sha256File(dest)
    if (current === MINIO_SHA256) {
      return dest
    }
  }
  const tmp = `${dest}.partial`
  await execFileAsync('curl', ['-fL', '--retry', '3', '-o', tmp, MINIO_URL])
  const downloaded = await sha256File(tmp)
  assert(downloaded === MINIO_SHA256, `MinIO checksum mismatch. Expected ${MINIO_SHA256}, got ${downloaded}.`)
  await fs.chmod(tmp, 0o755)
  await fs.rename(tmp, dest)
  return dest
}

async function writeState(state) {
  await fs.mkdir(path.dirname(state.statePath), {recursive: true})
  await fs.writeFile(state.statePath, JSON.stringify(state, null, 2))
}

async function readState(statePath) {
  const raw = await fs.readFile(statePath, 'utf8')
  return JSON.parse(raw)
}

async function resolveStatePath(explicit) {
  if (explicit) {
    return explicit
  }
  if (process.env.VERIFY_STATE) {
    return process.env.VERIFY_STATE
  }
  const pointed = await fs.readFile(currentPointer, 'utf8').catch(() => '')
  const trimmed = pointed.trim()
  if (!trimmed) {
    throw new Error('No verification instance. Run launch, or pass --state.')
  }
  return trimmed
}

async function currentIsLive() {
  const pointed = await fs.readFile(currentPointer, 'utf8').catch(() => '')
  if (!pointed.trim()) {
    return false
  }
  const state = await readState(pointed.trim()).catch(() => null)
  return Boolean(state && pidAlive(state.pid))
}

async function launch() {
  const pkg = JSON.parse(await fs.readFile(path.join(repoRoot, 'package.json'), 'utf8'))
  assert(pkg.name === 's3-artifact', `Expected to run from the github-s3-artifact checkout. package.json name is ${pkg.name}.`)
  const nodeBin = findNodeBin()
  const minioBin = await ensureMinio()
  const id = `run-${Date.now()}`
  const scratchDir = path.join(runtimeRoot, id)
  const dataDir = path.join(scratchDir, 'data')
  const workspace = path.join(scratchDir, 'workspace')
  const minioLog = path.join(scratchDir, 'minio.log')
  await fs.mkdir(dataDir, {recursive: true})
  await fs.mkdir(workspace, {recursive: true})
  const port = await freePort()
  const consolePort = await freePort()
  const logFd = await fs.open(minioLog, 'a')
  const child = spawn(
    minioBin,
    ['server', dataDir, '--address', `127.0.0.1:${port}`, '--console-address', `127.0.0.1:${consolePort}`],
    {
      detached: true,
      stdio: ['ignore', logFd.fd, logFd.fd],
      env: {
        PATH: process.env.PATH ?? '',
        HOME: os.homedir(),
        MINIO_ROOT_USER: ACCESS_KEY,
        MINIO_ROOT_PASSWORD: SECRET_KEY
      }
    }
  )
  child.unref()
  await logFd.close()
  const endpoint = `http://127.0.0.1:${port}`
  const state = {
    id,
    pid: child.pid,
    endpoint,
    port,
    consolePort,
    dataDir,
    scratchDir,
    workspace,
    bucket: BUCKET,
    keyPrefix: KEY_PREFIX,
    repository: REPOSITORY,
    githubRunId: Date.now(),
    accessKey: ACCESS_KEY,
    secretKey: SECRET_KEY,
    nodeBin,
    minioBin,
    minioVersion: MINIO_VERSION,
    minioLog,
    statePath: path.join(scratchDir, 'state.json'),
    startedAt: new Date().toISOString()
  }
  try {
    await waitForMinio(state)
    await createBucket(state)
    state.listenerPids = await listeners(port)
    await writeState(state)
    const live = await currentIsLive()
    if (!live) {
      await fs.mkdir(runtimeRoot, {recursive: true})
      await fs.writeFile(currentPointer, state.statePath)
    }
    console.log(`VERIFY_STATE=${state.statePath}`)
    console.log(`endpoint=${state.endpoint}`)
    console.log(`github_run_id=${state.githubRunId}`)
    console.log(`node=${execFileSyncVersion(nodeBin)}`)
    console.log(`minio=${MINIO_VERSION}`)
    if (live) {
      console.log('current pointer left unchanged because another instance is live. Pass --state to later commands.')
    }
  } catch (error) {
    await stopPid(child.pid)
    throw error
  }
}

async function waitForMinio(state) {
  const deadline = Date.now() + 30_000
  let lastError = 'no response'
  while (Date.now() < deadline) {
    if (!pidAlive(state.pid)) {
      const log = await fs.readFile(state.minioLog, 'utf8').catch(() => '')
      throw new Error(`MinIO exited before it became healthy.\n${log.slice(-2000)}`)
    }
    try {
      const response = await fetch(`${state.endpoint}/minio/health/live`)
      if (response.ok) {
        return
      }
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    await sleep(300)
  }
  const log = await fs.readFile(state.minioLog, 'utf8').catch(() => '')
  throw new Error(`MinIO did not become healthy at ${state.endpoint} (${lastError}).\n${log.slice(-2000)}`)
}

async function createBucket(state) {
  const {S3Client, CreateBucketCommand, HeadBucketCommand} = await loadS3()
  const client = s3Client(S3Client, state)
  try {
    try {
      await client.send(new HeadBucketCommand({Bucket: state.bucket}))
    } catch {
      await client.send(new CreateBucketCommand({Bucket: state.bucket}))
    }
  } finally {
    client.destroy()
  }
}

async function doctor(explicitState) {
  const statePath = await resolveStatePath(explicitState)
  const state = await readState(statePath)
  const problems = []
  if (!pidAlive(state.pid)) {
    problems.push(`MinIO pid ${state.pid} is not running`)
  }
  const liveListeners = await listeners(state.port).catch(error => {
    problems.push(`lsof failed: ${error instanceof Error ? error.message : String(error)}`)
    return []
  })
  if (pidAlive(state.pid) && !liveListeners.includes(String(state.pid))) {
    problems.push(`port ${state.port} listeners [${liveListeners.join(', ')}] do not include MinIO pid ${state.pid}`)
  }
  try {
    const response = await fetch(`${state.endpoint}/minio/health/live`)
    if (!response.ok) {
      problems.push(`health endpoint returned HTTP ${response.status}`)
    }
  } catch (error) {
    problems.push(`health request failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  const {S3Client, HeadBucketCommand} = await loadS3()
  const client = s3Client(S3Client, state)
  try {
    await client.send(new HeadBucketCommand({Bucket: state.bucket}))
  } catch (error) {
    problems.push(`HeadBucket ${state.bucket} failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    client.destroy()
  }
  const uploadBundle = path.join(repoRoot, 'dist/upload/index.js')
  const downloadBundle = path.join(repoRoot, 'dist/download/index.js')
  const mergeBundle = path.join(repoRoot, 'dist/merge/index.js')
  for (const bundle of [uploadBundle, downloadBundle, mergeBundle]) {
    const stat = await fs.stat(bundle).catch(() => null)
    if (!stat || stat.size < 1000) {
      problems.push(`missing built bundle ${bundle}. Run npm run build.`)
    }
  }
  let version = 'unknown'
  try {
    version = execFileSyncVersion(state.nodeBin)
  } catch (error) {
    problems.push(`cannot run node at ${state.nodeBin}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const major = Number(version.replace(/^v/, '').split('.')[0])
  if (Number.isFinite(major) && major < 22) {
    problems.push(`node ${version} is below engines.node >=22`)
  }
  if (problems.length > 0) {
    console.error(problems.join('\n'))
    throw new Error('doctor failed')
  }
  const uploadSha = await sha256File(uploadBundle)
  const downloadSha = await sha256File(downloadBundle)
  const mergeSha = await sha256File(mergeBundle)
  console.log('doctor ok')
  console.log('health: live')
  console.log(`endpoint: ${state.endpoint}`)
  console.log(`bucket: ${state.bucket}`)
  console.log(`node: ${version}`)
  console.log(`node-bin: ${state.nodeBin}`)
  console.log(`minio: ${state.minioVersion}`)
  console.log(`minio-pid: ${state.pid}`)
  console.log(`listener-pids: ${liveListeners.join(',')}`)
  console.log(`github-run-id: ${state.githubRunId}`)
  console.log(`upload-bundle-sha256: ${uploadSha}`)
  console.log(`download-bundle-sha256: ${downloadSha}`)
  console.log(`merge-bundle-sha256: ${mergeSha}`)
  if (major !== 24) {
    console.log(`runtime-gap: action.yml requests node24, selected node is ${version}`)
  }
  return state
}

async function runAction(state, which, inputs, label, extraEnv = {}) {
  const outputFile = path.join(state.scratchDir, `github-output-${label}.txt`)
  await fs.writeFile(outputFile, '')
  const bundle = path.join(repoRoot, 'dist', which, 'index.js')
  const env = {
    PATH: process.env.PATH ?? '',
    HOME: os.homedir(),
    GITHUB_WORKSPACE: state.workspace,
    GITHUB_REPOSITORY: state.repository,
    GITHUB_RUN_ID: String(state.githubRunId),
    GITHUB_RUN_ATTEMPT: '1',
    GITHUB_OUTPUT: outputFile,
    S3_ARTIFACT_BUCKET: state.bucket,
    S3_ARTIFACT_KEY_PREFIX: state.keyPrefix,
    S3_ARTIFACT_ENDPOINT: state.endpoint,
    S3_ARTIFACT_REGION: 'us-east-1',
    S3_ARTIFACT_FORCE_PATH_STYLE: 'true',
    AWS_ACCESS_KEY_ID: state.accessKey,
    AWS_SECRET_ACCESS_KEY: state.secretKey,
    ...inputEnv(inputs),
    ...extraEnv
  }
  const command = `${state.nodeBin} ${bundle}`
  const result = await new Promise(resolve => {
    const child = spawn(state.nodeBin, [bundle], {
      cwd: state.workspace,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
    }, 60_000)
    child.stdout.on('data', chunk => {
      stdout += String(chunk)
    })
    child.stderr.on('data', chunk => {
      stderr += String(chunk)
    })
    child.on('close', code => {
      clearTimeout(timer)
      resolve({code: code ?? 1, stdout, stderr})
    })
  })
  const outputText = await fs.readFile(outputFile, 'utf8')
  return {
    ...result,
    outputText,
    outputs: parseGitHubOutput(outputText),
    command,
    envSummary: envSummary(env),
    label
  }
}

function envSummary(env) {
  const lines = []
  for (const [key, value] of Object.entries(env)) {
    if (key === 'AWS_SECRET_ACCESS_KEY') {
      lines.push(`${key}=<minio root password from launch>`)
    } else {
      lines.push(`${key}=${value}`)
    }
  }
  return lines.join('\n')
}

async function writeEvidence(dir, run, extra) {
  await fs.mkdir(dir, {recursive: true})
  await fs.writeFile(path.join(dir, 'command.txt'), `${run.command}\n\n${run.envSummary}\n`)
  await fs.writeFile(path.join(dir, 'stdout.txt'), run.stdout)
  await fs.writeFile(path.join(dir, 'stderr.txt'), run.stderr)
  await fs.writeFile(path.join(dir, 'exit-code.txt'), String(run.code))
  await fs.writeFile(path.join(dir, 'github-output.txt'), run.outputText)
  if (extra?.objects) {
    await fs.writeFile(path.join(dir, 'objects.json'), JSON.stringify(extra.objects, null, 2))
  }
  if (extra?.blob) {
    await fs.writeFile(path.join(dir, extra.blobName ?? 'blob.bin'), extra.blob)
  }
  if (extra?.summary) {
    await fs.writeFile(path.join(dir, 'summary.md'), extra.summary)
  }
}

async function withClient(state, fn) {
  const api = await loadS3()
  const client = s3Client(api.S3Client, state)
  try {
    return await fn(client, api)
  } finally {
    client.destroy()
  }
}

async function headObject(client, api, bucket, key) {
  const response = await client.send(new api.HeadObjectCommand({Bucket: bucket, Key: key}))
  return {
    key,
    etag: response.ETag ?? '',
    size: Number(response.ContentLength ?? -1),
    contentType: response.ContentType ?? ''
  }
}

async function getObjectBuffer(client, api, bucket, key) {
  const response = await client.send(new api.GetObjectCommand({Bucket: bucket, Key: key}))
  const bytes = await response.Body.transformToByteArray()
  return Buffer.from(bytes)
}

async function assertAbsent(client, api, bucket, key) {
  try {
    await client.send(new api.HeadObjectCommand({Bucket: bucket, Key: key}))
  } catch (error) {
    if (isNotFound(error)) {
      return
    }
    throw error
  }
  throw new Error(`Expected no object at ${key}`)
}

function combinedOutput(run) {
  return `${run.stdout}\n${run.stderr}`
}

async function readZipEntry(zipPath, entryName) {
  const {stdout} = await execFileAsync(
    'python3',
    [
      '-c',
      'import json, sys, zipfile\nz = zipfile.ZipFile(sys.argv[1])\nbody = z.read(sys.argv[2]).decode()\njson.dump({"names": z.namelist(), "body": body}, sys.stdout)\n',
      zipPath,
      entryName
    ],
    {encoding: 'utf8', maxBuffer: 10 * 1024 * 1024}
  )
  return JSON.parse(stdout)
}

async function driveUploadArchive(state) {
  const dir = path.join(evidenceRoot, state.id, 'upload-archive')
  const filePath = path.join(state.workspace, 'dist-fixture/app.txt')
  await fs.mkdir(path.dirname(filePath), {recursive: true})
  await fs.writeFile(filePath, HELLO_BODY)
  const run = await runAction(state, 'upload', {name: 'build-dist', path: 'dist-fixture/app.txt'}, 'upload-archive')
  let objects
  let summary
  try {
    assert(run.code === 0, `upload exit ${run.code}\n${combinedOutput(run)}`)
    assert(combinedOutput(run).includes("Artifact 'build-dist' uploaded"), 'stdout missing upload confirmation')
    const id = run.outputs['artifact-id']
    const digest = run.outputs['artifact-digest']
    const url = run.outputs['artifact-url']
    assert(/^\d+$/.test(id ?? ''), `artifact-id is not a positive integer: ${id}`)
    assert(/^[0-9a-f]{64}$/.test(digest ?? ''), `artifact-digest is not 64 hex chars: ${digest}`)
    const key = manifestKey(state, 'build-dist')
    objects = await withClient(state, async (client, api) => {
      const manifestHead = await headObject(client, api, state.bucket, key)
      const manifestBytes = await getObjectBuffer(client, api, state.bucket, key)
      const manifest = JSON.parse(manifestBytes.toString('utf8'))
      const blobHead = await headObject(client, api, state.bucket, manifest.blobKey)
      const blob = await getObjectBuffer(client, api, state.bucket, manifest.blobKey)
      const blobSha = sha256(blob)
      assert(manifest.name === 'build-dist', `manifest name ${manifest.name}`)
      assert(String(manifest.id) === id, `manifest id ${manifest.id} != output ${id}`)
      assert(manifest.digest === `sha256:${digest}`, `manifest digest ${manifest.digest}`)
      assert(manifest.archived === true, 'manifest archived is not true')
      assert(manifest.size === blobHead.size, `manifest size ${manifest.size} != blob size ${blobHead.size}`)
      assert(blobSha === digest, `blob sha256 ${blobSha} != output digest ${digest}`)
      assert(url === `s3://${state.bucket}/${manifest.blobKey}`, `artifact-url ${url}`)
      assert(manifest.blobKey.endsWith(`/blobs/${id}`), `blob key ${manifest.blobKey}`)
      const zipPath = path.join(dir, 'blob.zip')
      await fs.mkdir(dir, {recursive: true})
      await fs.writeFile(zipPath, blob)
      const zip = await readZipEntry(zipPath, 'app.txt')
      assert(zip.names.includes('app.txt'), `zip entries ${zip.names.join(', ')}`)
      assert(!zip.names.includes('dist-fixture/app.txt'), 'zip kept the parent directory')
      assert(zip.body === HELLO_BODY, `zip entry body ${JSON.stringify(zip.body)}`)
      const source = await fs.readFile(filePath, 'utf8')
      assert(source === HELLO_BODY, 'upload removed or changed the workspace file')
      return {
        blob: blobHead,
        manifest: manifestHead,
        manifestBody: manifest,
        blobSha256: blobSha,
        zipEntries: zip.names
      }
    })
    summary = [
      '# upload-archive',
      '',
      'The built upload action stored one zip and wrote the three step outputs.',
      '',
      `- Exit code: ${run.code}`,
      `- artifact-id: ${run.outputs['artifact-id']}`,
      `- artifact-digest: ${run.outputs['artifact-digest']}`,
      `- artifact-url: ${run.outputs['artifact-url']}`,
      `- Blob key: ${objects.blob.key}`,
      `- Blob ETag: ${objects.blob.etag}`,
      `- Blob size: ${objects.blob.size}`,
      `- Blob sha256: ${objects.blobSha256}`,
      `- Manifest key: ${objects.manifest.key}`,
      `- Manifest ETag: ${objects.manifest.etag}`,
      `- Manifest size: ${objects.manifest.size}`,
      `- Zip entries: ${objects.zipEntries.join(', ')}`,
      '- Zip entry `app.txt` matches the workspace file.'
    ].join('\n')
    await writeEvidence(dir, run, {objects, summary, blob: undefined})
    console.log('drive ok upload-archive')
    console.log(`evidence: ${dir}`)
  } catch (error) {
    summary = `# upload-archive\n\nFailed.\n\n${error instanceof Error ? error.message : String(error)}\n`
    await writeEvidence(dir, run, {objects, summary})
    throw error
  }
}

async function driveUploadRaw(state) {
  const dir = path.join(evidenceRoot, state.id, 'upload-raw')
  const filePath = path.join(state.workspace, 'single-dir/app.tar.gz')
  await fs.mkdir(path.dirname(filePath), {recursive: true})
  await fs.writeFile(filePath, RAW_BODY)
  const run = await runAction(
    state,
    'upload',
    {name: 'ignored-name', path: 'single-dir/app.tar.gz', archive: 'false'},
    'upload-raw'
  )
  let objects
  try {
    assert(run.code === 0, `upload exit ${run.code}\n${combinedOutput(run)}`)
    const digest = run.outputs['artifact-digest']
    assert(sha256(Buffer.from(RAW_BODY)) === digest, 'raw digest does not match the file bytes')
    const key = manifestKey(state, 'app.tar.gz')
    objects = await withClient(state, async (client, api) => {
      const manifestBytes = await getObjectBuffer(client, api, state.bucket, key)
      const manifest = JSON.parse(manifestBytes.toString('utf8'))
      const blobHead = await headObject(client, api, state.bucket, manifest.blobKey)
      const blob = await getObjectBuffer(client, api, state.bucket, manifest.blobKey)
      const manifestHead = await headObject(client, api, state.bucket, key)
      assert(manifest.name === 'app.tar.gz', `artifact name ${manifest.name}`)
      assert(manifest.archived === false, 'raw upload was archived')
      assert(manifest.rawFileName === 'app.tar.gz', `rawFileName ${manifest.rawFileName}`)
      assert(manifest.contentType === 'application/gzip', `content type ${manifest.contentType}`)
      assert(blob.toString('utf8') === RAW_BODY, 'stored bytes differ from the file')
      assert(run.outputs['artifact-url'] === `s3://${state.bucket}/${manifest.blobKey}`, 'artifact-url mismatch')
      await assertAbsent(client, api, state.bucket, manifestKey(state, 'ignored-name'))
      return {blob: blobHead, manifest: manifestHead, manifestBody: manifest}
    })
    const summary = [
      '# upload-raw',
      '',
      'archive false stored the file bytes under the basename.',
      '',
      `- Exit code: ${run.code}`,
      `- artifact-id: ${run.outputs['artifact-id']}`,
      `- artifact-digest: ${run.outputs['artifact-digest']}`,
      `- artifact-url: ${run.outputs['artifact-url']}`,
      `- Blob key: ${objects.blob.key}`,
      `- Blob ETag: ${objects.blob.etag}`,
      `- Blob size: ${objects.blob.size}`,
      `- Manifest key: ${objects.manifest.key}`,
      `- Manifest ETag: ${objects.manifest.etag}`,
      '- Manifest name is `app.tar.gz`. No object was written for `ignored-name`.'
    ].join('\n')
    await writeEvidence(dir, run, {objects, summary})
    console.log('drive ok upload-raw')
    console.log(`evidence: ${dir}`)
  } catch (error) {
    await writeEvidence(dir, run, {
      objects,
      summary: `# upload-raw\n\nFailed.\n\n${error instanceof Error ? error.message : String(error)}\n`
    })
    throw error
  }
}

async function driveDownloadByName(state) {
  const dir = path.join(evidenceRoot, state.id, 'download-by-name')
  const key = manifestKey(state, 'build-dist')
  const present = await withClient(state, async (client, api) => {
    try {
      await headObject(client, api, state.bucket, key)
      return true
    } catch (error) {
      if (isNotFound(error)) {
        return false
      }
      throw error
    }
  })
  if (!present) {
    const summary = [
      '# download-by-name',
      '',
      'Failed. Unmet precondition: this run has no `build-dist` manifest.',
      'Run `drive upload-archive` on the same state first.'
    ].join('\n')
    await fs.mkdir(dir, {recursive: true})
    await fs.writeFile(path.join(dir, 'summary.md'), `${summary}\n`)
    throw new Error(summary)
  }
  const run = await runAction(state, 'download', {name: 'build-dist', path: 'out/build-dist'}, 'download-by-name')
  try {
    assert(run.code === 0, `download exit ${run.code}\n${combinedOutput(run)}`)
    const dest = path.resolve(state.workspace, 'out/build-dist')
    assert(run.outputs['download-path'] === dest, `download-path ${run.outputs['download-path']}`)
    assert(combinedOutput(run).includes('Download artifact has finished successfully'), 'missing download success line')
    const extracted = await fs.readFile(path.join(dest, 'app.txt'), 'utf8')
    assert(extracted === HELLO_BODY, `extracted body ${JSON.stringify(extracted)}`)
    const nested = await fs.stat(path.join(dest, 'build-dist')).catch(() => null)
    assert(!nested, 'single named download created a name subdirectory')
    const summary = [
      '# download-by-name',
      '',
      'Download extracted the zip from the previous upload into the destination directory.',
      '',
      `- Exit code: ${run.code}`,
      `- download-path: ${run.outputs['download-path']}`,
      `- Extracted file: ${path.join(dest, 'app.txt')}`,
      '- File body matches `hello from verify`.'
    ].join('\n')
    await writeEvidence(dir, run, {summary})
    console.log('drive ok download-by-name')
    console.log(`evidence: ${dir}`)
  } catch (error) {
    await writeEvidence(dir, run, {
      summary: `# download-by-name\n\nFailed.\n\n${error instanceof Error ? error.message : String(error)}\n`
    })
    throw error
  }
}

async function driveRejectDuplicate(state) {
  const dir = path.join(evidenceRoot, state.id, 'reject-duplicate')
  const filePath = path.join(state.workspace, 'dup/payload.txt')
  await fs.mkdir(path.dirname(filePath), {recursive: true})
  await fs.writeFile(filePath, 'first\n')
  const first = await runAction(state, 'upload', {name: 'dup-check', path: 'dup/payload.txt'}, 'reject-duplicate-first')
  assert(first.code === 0, `first upload exit ${first.code}\n${combinedOutput(first)}`)
  const key = manifestKey(state, 'dup-check')
  const before = await withClient(state, async (client, api) => {
    const manifestBytes = await getObjectBuffer(client, api, state.bucket, key)
    const manifest = JSON.parse(manifestBytes.toString('utf8'))
    const blobHead = await headObject(client, api, state.bucket, manifest.blobKey)
    return {manifest, blobHead, manifestEtag: (await headObject(client, api, state.bucket, key)).etag}
  })
  await fs.writeFile(filePath, 'second\n')
  const second = await runAction(
    state,
    'upload',
    {name: 'dup-check', path: 'dup/payload.txt', overwrite: 'false'},
    'reject-duplicate-second'
  )
  let after
  try {
    assert(second.code === 1, `second upload exit ${second.code}, expected 1`)
    assert(combinedOutput(second).includes('already exists'), 'duplicate error text missing')
    after = await withClient(state, async (client, api) => {
      const manifestBytes = await getObjectBuffer(client, api, state.bucket, key)
      const manifest = JSON.parse(manifestBytes.toString('utf8'))
      const blobHead = await headObject(client, api, state.bucket, manifest.blobKey)
      const blob = await getObjectBuffer(client, api, state.bucket, manifest.blobKey)
      const zipPath = path.join(dir, 'blob.zip')
      await fs.mkdir(dir, {recursive: true})
      await fs.writeFile(zipPath, blob)
      const zip = await readZipEntry(zipPath, 'payload.txt')
      assert(blobHead.etag === before.blobHead.etag, `blob ETag changed from ${before.blobHead.etag} to ${blobHead.etag}`)
      assert(blobHead.size === before.blobHead.size, 'blob size changed')
      assert(manifest.digest === before.manifest.digest, 'manifest digest changed')
      assert(zip.body === 'first\n', `stored entry is ${JSON.stringify(zip.body)}`)
      return {blobHead, manifest}
    })
    const summary = [
      '# reject-duplicate',
      '',
      'The second upload with overwrite false failed, and the first object stayed in place.',
      '',
      `- First exit code: ${first.code}`,
      `- First artifact-id: ${first.outputs['artifact-id']}`,
      `- First artifact-digest: ${first.outputs['artifact-digest']}`,
      `- Second exit code: ${second.code}`,
      `- Blob key: ${before.blobHead.key}`,
      `- Blob ETag before and after: ${before.blobHead.etag}`,
      `- Blob size: ${before.blobHead.size}`,
      `- Manifest ETag: ${before.manifestEtag}`,
      '- Stored zip entry `payload.txt` is still `first`.'
    ].join('\n')
    await fs.mkdir(dir, {recursive: true})
    await fs.writeFile(path.join(dir, 'first-stdout.txt'), first.stdout)
    await fs.writeFile(path.join(dir, 'first-exit-code.txt'), String(first.code))
    await fs.writeFile(path.join(dir, 'second-stdout.txt'), second.stdout)
    await fs.writeFile(path.join(dir, 'second-stderr.txt'), second.stderr)
    await fs.writeFile(path.join(dir, 'second-exit-code.txt'), String(second.code))
    await fs.writeFile(
      path.join(dir, 'objects.json'),
      JSON.stringify({before: before.blobHead, after: after.blobHead, manifestDigest: before.manifest.digest}, null, 2)
    )
    await fs.writeFile(path.join(dir, 'summary.md'), `${summary}\n`)
    console.log('drive ok reject-duplicate')
    console.log(`evidence: ${dir}`)
  } catch (error) {
    await fs.mkdir(dir, {recursive: true})
    await fs.writeFile(
      path.join(dir, 'summary.md'),
      `# reject-duplicate\n\nFailed.\n\n${error instanceof Error ? error.message : String(error)}\n`
    )
    throw error
  }
}

async function driveNoFiles(state) {
  const dir = path.join(evidenceRoot, state.id, 'no-files')
  const cases = [
    {name: 'missing-warn', behavior: 'warn', code: 0, warning: true},
    {name: 'missing-error', behavior: 'error', code: 1, warning: false},
    {name: 'missing-ignore', behavior: 'ignore', code: 0, warning: false}
  ]
  const rows = []
  for (const item of cases) {
    const run = await runAction(
      state,
      'upload',
      {name: item.name, path: `${item.name}/**`, 'if-no-files-found': item.behavior},
      `no-files-${item.behavior}`
    )
    const caseDir = path.join(dir, item.behavior)
    await writeEvidence(caseDir, run, {})
    const text = combinedOutput(run)
    const message = `No files were found with the provided path: ${item.name}/**. No artifacts will be uploaded.`
    assert(run.code === item.code, `${item.behavior} exit ${run.code}, expected ${item.code}\n${text}`)
    assert(text.includes(message), `${item.behavior} missing no-files message`)
    if (item.warning) {
      assert(run.stdout.includes(`::warning::${message}`), 'warn did not emit ::warning::')
    } else {
      assert(!run.stdout.includes(`::warning::${message}`), `${item.behavior} emitted ::warning::`)
    }
    if (item.code === 1) {
      assert(run.stdout.includes('::error::'), 'error did not emit ::error::')
    }
    assert(Object.keys(run.outputs).length === 0, `${item.behavior} wrote outputs ${JSON.stringify(run.outputs)}`)
    await withClient(state, async (client, api) => {
      await assertAbsent(client, api, state.bucket, manifestKey(state, item.name))
    })
    rows.push(`- ${item.behavior}: exit ${run.code}, manifest absent, outputs empty`)
  }
  const summary = ['# no-files', '', 'A path that matches nothing writes no S3 object.', '', ...rows].join('\n')
  await fs.writeFile(path.join(dir, 'summary.md'), `${summary}\n`)
  console.log('drive ok no-files')
  console.log(`evidence: ${dir}`)
}

async function drivePresignedUrl(state) {
  const dir = path.join(evidenceRoot, state.id, 'presigned-url')
  const filePath = path.join(state.workspace, 'dist-fixture/app.txt')
  await fs.mkdir(path.dirname(filePath), {recursive: true})
  await fs.writeFile(filePath, HELLO_BODY)
  const run = await runAction(
    state,
    'upload',
    {
      name: 'presigned-one',
      path: 'dist-fixture/app.txt',
      'artifact-url-format': 'presigned',
      'presign-expires-seconds': '120'
    },
    'presigned-url'
  )
  let objects
  let summary
  try {
    assert(run.code === 0, `upload exit ${run.code}\n${combinedOutput(run)}`)
    const url = run.outputs['artifact-url']
    assert(typeof url === 'string' && url.startsWith('http'), `artifact-url ${url}`)
    assert(!url.startsWith('s3://'), 'presigned output stayed an s3 URI')
    const id = run.outputs['artifact-id']
    const digest = run.outputs['artifact-digest']
    assert(url.includes(`/blobs/${id}`), `signed URL missing blob id: ${url}`)
    const response = await fetch(url)
    assert(response.ok, `GET presigned URL returned HTTP ${response.status}`)
    const downloaded = Buffer.from(await response.arrayBuffer())
    const downloadedSha = sha256(downloaded)
    assert(downloadedSha === digest, `downloaded sha ${downloadedSha} != ${digest}`)
    const key = manifestKey(state, 'presigned-one')
    objects = await withClient(state, async (client, api) => {
      const manifestBytes = await getObjectBuffer(client, api, state.bucket, key)
      const manifest = JSON.parse(manifestBytes.toString('utf8'))
      const blob = await getObjectBuffer(client, api, state.bucket, manifest.blobKey)
      assert(sha256(blob) === digest, 'stored blob sha does not match the output digest')
      const zipPath = path.join(dir, 'blob.zip')
      await fs.mkdir(dir, {recursive: true})
      await fs.writeFile(zipPath, blob)
      const zip = await readZipEntry(zipPath, 'app.txt')
      assert(zip.body === HELLO_BODY, `zip entry ${JSON.stringify(zip.body)}`)
      return {manifestBody: manifest, downloadedSha}
    })
    summary = [
      '# presigned-url',
      '',
      'Upload with artifact-url-format=presigned returned a signed URL that downloaded the zip.',
      '',
      `- Exit code: ${run.code}`,
      `- artifact-id: ${id}`,
      `- artifact-digest: ${digest}`,
      `- artifact-url scheme: ${new URL(url).protocol}`,
      `- Downloaded sha256: ${objects.downloadedSha}`,
      '- Zip entry `app.txt` matches the workspace file.'
    ].join('\n')
    await writeEvidence(dir, run, {objects, summary})
    console.log('drive ok presigned-url')
    console.log(`evidence: ${dir}`)
  } catch (error) {
    summary = `# presigned-url\n\nFailed.\n\n${error instanceof Error ? error.message : String(error)}\n`
    await writeEvidence(dir, run, {objects, summary})
    throw error
  }
}

async function driveArtifactListCap(state) {
  const dir = path.join(evidenceRoot, state.id, 'artifact-list-cap')
  await fs.mkdir(path.join(state.workspace, 'cap'), {recursive: true})
  await fs.writeFile(path.join(state.workspace, 'cap/a.txt'), 'alpha\n')
  await fs.writeFile(path.join(state.workspace, 'cap/b.txt'), 'beta\n')
  const first = await runAction(state, 'upload', {name: 'side-a', path: 'cap/a.txt'}, 'cap-upload-a')
  const second = await runAction(state, 'upload', {name: 'side-b', path: 'cap/b.txt'}, 'cap-upload-b')
  const run = await runAction(
    state,
    'download',
    {path: 'out-cap'},
    'artifact-list-cap',
    {ACTIONS_ARTIFACT_MAX_ARTIFACT_COUNT: '1'}
  )
  let summary
  try {
    assert(first.code === 0, `side-a upload exit ${first.code}\n${combinedOutput(first)}`)
    assert(second.code === 0, `side-b upload exit ${second.code}\n${combinedOutput(second)}`)
    assert(run.code === 0, `download exit ${run.code}\n${combinedOutput(run)}`)
    assert(
      combinedOutput(run).includes('limit of 1'),
      'download did not warn about the artifact list cap'
    )
    const kept = await fs.readFile(path.join(state.workspace, 'out-cap/a.txt'), 'utf8')
    assert(kept === 'alpha\n', `kept body ${JSON.stringify(kept)}`)
    const nested = await fs.stat(path.join(state.workspace, 'out-cap/side-a')).then(() => true).catch(() => false)
    const dropped = await fs.stat(path.join(state.workspace, 'out-cap/side-b')).then(() => true).catch(() => false)
    assert(nested === false, 'a single listed artifact was extracted into a name directory')
    assert(dropped === false, 'side-b was downloaded despite the cap of 1')
    const sideBKey = manifestKey(state, 'side-b')
    await withClient(state, async (client, api) => {
      await headObject(client, api, state.bucket, sideBKey)
    })
    summary = [
      '# artifact-list-cap',
      '',
      'Download listed only the first artifact when ACTIONS_ARTIFACT_MAX_ARTIFACT_COUNT=1.',
      '',
      `- Exit code: ${run.code}`,
      '- Kept: out-cap/a.txt = alpha',
      '- Absent: out-cap/side-b',
      '- side-b manifest is still in the bucket.',
      '- Warning includes `limit of 1`.'
    ].join('\n')
    await writeEvidence(dir, run, {summary})
    console.log('drive ok artifact-list-cap')
    console.log(`evidence: ${dir}`)
  } catch (error) {
    summary = `# artifact-list-cap\n\nFailed.\n\n${error instanceof Error ? error.message : String(error)}\n`
    await writeEvidence(dir, run, {summary})
    throw error
  }
}

async function stopPid(pid) {
  if (!pid || !pidAlive(pid)) {
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      return
    }
  }
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && pidAlive(pid)) {
    await sleep(200)
  }
  if (!pidAlive(pid)) {
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      return
    }
  }
}

async function cleanup(explicitState) {
  const statePath = await resolveStatePath(explicitState)
  const state = await readState(statePath)
  await stopPid(state.pid)
  const pointed = await fs.readFile(currentPointer, 'utf8').catch(() => '')
  if (pointed.trim() === state.statePath) {
    await fs.rm(currentPointer, {force: true})
  }
  await fs.rm(state.scratchDir, {recursive: true, force: true})
  console.log(`cleanup ok ${state.id}`)
  console.log(`evidence kept under ${path.join(evidenceRoot, state.id)}`)
}

async function driveMergeArtifacts(state) {
  const dir = path.join(evidenceRoot, state.id, 'merge-artifacts')
  await fs.mkdir(path.join(state.workspace, 'merge-src'), {recursive: true})
  await fs.writeFile(path.join(state.workspace, 'merge-src/left.txt'), 'left-body\n')
  await fs.writeFile(path.join(state.workspace, 'merge-src/right.txt'), 'right-body\n')
  const left = await runAction(
    state,
    'upload',
    {name: 'side-left', path: 'merge-src/left.txt'},
    'merge-upload-left'
  )
  const right = await runAction(
    state,
    'upload',
    {name: 'side-right', path: 'merge-src/right.txt'},
    'merge-upload-right'
  )
  const run = await runAction(
    state,
    'merge',
    {name: 'merged-sides', pattern: 'side-*', 'delete-merged': 'true'},
    'merge-artifacts'
  )
  let objects
  let summary
  try {
    assert(left.code === 0, `left upload exit ${left.code}\n${combinedOutput(left)}`)
    assert(right.code === 0, `right upload exit ${right.code}\n${combinedOutput(right)}`)
    assert(run.code === 0, `merge exit ${run.code}\n${combinedOutput(run)}`)
    assert(combinedOutput(run).includes('2 artifact(s) have been deleted'), 'merge did not delete both sources')
    const id = run.outputs['artifact-id']
    const digest = run.outputs['artifact-digest']
    const url = run.outputs['artifact-url']
    assert(/^\d+$/.test(id ?? ''), `artifact-id is not a positive integer: ${id}`)
    assert(/^[0-9a-f]{64}$/.test(digest ?? ''), `artifact-digest is not 64 hex chars: ${digest}`)
    const mergedKey = manifestKey(state, 'merged-sides')
    const leftKey = manifestKey(state, 'side-left')
    const rightKey = manifestKey(state, 'side-right')
    objects = await withClient(state, async (client, api) => {
      await assertAbsent(client, api, state.bucket, leftKey)
      await assertAbsent(client, api, state.bucket, rightKey)
      const manifestHead = await headObject(client, api, state.bucket, mergedKey)
      const manifestBytes = await getObjectBuffer(client, api, state.bucket, mergedKey)
      const manifest = JSON.parse(manifestBytes.toString('utf8'))
      const blobHead = await headObject(client, api, state.bucket, manifest.blobKey)
      const blob = await getObjectBuffer(client, api, state.bucket, manifest.blobKey)
      const blobSha = sha256(blob)
      assert(manifest.name === 'merged-sides', `manifest name ${manifest.name}`)
      assert(String(manifest.id) === id, `manifest id ${manifest.id} != output ${id}`)
      assert(manifest.digest === `sha256:${digest}`, `manifest digest ${manifest.digest}`)
      assert(blobSha === digest, `blob sha256 ${blobSha} != output digest ${digest}`)
      assert(url === `s3://${state.bucket}/${manifest.blobKey}`, `artifact-url ${url}`)
      const zipPath = path.join(dir, 'blob.zip')
      await fs.mkdir(dir, {recursive: true})
      await fs.writeFile(zipPath, blob)
      const leftEntry = await readZipEntry(zipPath, 'left.txt')
      const rightEntry = await readZipEntry(zipPath, 'right.txt')
      assert(leftEntry.body === 'left-body\n', `left entry ${JSON.stringify(leftEntry.body)}`)
      assert(rightEntry.body === 'right-body\n', `right entry ${JSON.stringify(rightEntry.body)}`)
      return {
        blob: blobHead,
        manifest: manifestHead,
        manifestBody: manifest,
        blobSha256: blobSha,
        zipEntries: leftEntry.names,
        deletedManifests: [leftKey, rightKey]
      }
    })
    summary = [
      '# merge-artifacts',
      '',
      'The merge action combined two uploads and deleted the source manifests.',
      '',
      `- Exit code: ${run.code}`,
      `- artifact-id: ${run.outputs['artifact-id']}`,
      `- artifact-digest: ${run.outputs['artifact-digest']}`,
      `- artifact-url: ${run.outputs['artifact-url']}`,
      `- Blob key: ${objects.blob.key}`,
      `- Blob ETag: ${objects.blob.etag}`,
      `- Blob size: ${objects.blob.size}`,
      `- Blob sha256: ${objects.blobSha256}`,
      `- Manifest key: ${objects.manifest.key}`,
      `- Zip entries: ${objects.zipEntries.join(', ')}`,
      '- Source manifests side-left and side-right are absent.'
    ].join('\n')
    await writeEvidence(dir, run, {objects, summary})
    console.log('drive ok merge-artifacts')
    console.log(`evidence: ${dir}`)
  } catch (error) {
    summary = `# merge-artifacts\n\nFailed.\n\n${error instanceof Error ? error.message : String(error)}\n`
    await writeEvidence(dir, run, {objects, summary})
    throw error
  }
}

async function main() {
  const {command, feature, statePath} = parseArgs(process.argv)
  if (command === 'launch') {
    await launch()
    return
  }
  if (command === 'doctor') {
    await doctor(statePath)
    return
  }
  if (command === 'cleanup') {
    await cleanup(statePath)
    return
  }
  if (command === 'drive') {
    const drives = {
      'upload-archive': driveUploadArchive,
      'upload-raw': driveUploadRaw,
      'download-by-name': driveDownloadByName,
      'reject-duplicate': driveRejectDuplicate,
      'no-files': driveNoFiles,
      'artifact-list-cap': driveArtifactListCap,
      'presigned-url': drivePresignedUrl,
      'merge-artifacts': driveMergeArtifacts
    }
    const drive = drives[feature]
    if (!drive) {
      throw new Error(`Unknown feature ${feature ?? ''}.\n${usage()}`)
    }
    const state = await doctor(statePath)
    await drive(state)
    return
  }
  throw new Error(usage())
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
