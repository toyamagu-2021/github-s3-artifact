import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import {createHash} from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {runActionBoundary} from '../helpers/action-harness.js'
import {InMemoryArtifactStore} from '../../src/storage/memory-store.js'
import {
  type ArtifactManifestV1,
  parseArtifactId,
  parseArtifactName,
  parseBucketName,
  parseRunScope,
  parseSha256Digest
} from '../../src/shared/types.js'
import {runUploadAction} from '../../src/upload/action.js'
import {runDownloadAction} from '../../src/download/action.js'
import {extractArchiveStream} from '../../src/core/extract-zip.js'

function createZipWithEntry(entryName: string, content: string): Buffer {
  const nameBuf = Buffer.from(entryName, 'utf8')
  const dataBuf = Buffer.from(content, 'utf8')
  let c = 0xffffffff
  for (const byte of dataBuf) {
    c ^= byte
    for (let i = 0; i < 8; i++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0)
    }
  }
  const crc = (c ^ 0xffffffff) >>> 0

  const localHeader = Buffer.alloc(30)
  localHeader.writeUInt32LE(0x04034b50, 0)
  localHeader.writeUInt16LE(20, 4)
  localHeader.writeUInt16LE(0, 6)
  localHeader.writeUInt16LE(0, 8)
  localHeader.writeUInt32LE(crc, 14)
  localHeader.writeUInt32LE(dataBuf.length, 18)
  localHeader.writeUInt32LE(dataBuf.length, 22)
  localHeader.writeUInt16LE(nameBuf.length, 26)

  const cdOffset = localHeader.length + nameBuf.length + dataBuf.length
  const centralHeader = Buffer.alloc(46)
  centralHeader.writeUInt32LE(0x02014b50, 0)
  centralHeader.writeUInt16LE(20, 4)
  centralHeader.writeUInt16LE(20, 6)
  centralHeader.writeUInt32LE(crc, 16)
  centralHeader.writeUInt32LE(dataBuf.length, 20)
  centralHeader.writeUInt32LE(dataBuf.length, 24)
  centralHeader.writeUInt16LE(nameBuf.length, 28)

  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(centralHeader.length + nameBuf.length, 12)
  eocd.writeUInt32LE(cdOffset, 16)

  return Buffer.concat([localHeader, nameBuf, dataBuf, centralHeader, nameBuf, eocd])
}

describe('Acceptance Criteria AC-01..AC-19', () => {
  let workspace: string
  let nowMs: number
  let store: InMemoryArtifactStore

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 's3-art-ac-'))
    nowMs = Date.parse('2026-06-01T00:00:00.000Z')
    store = new InMemoryArtifactStore(
      parseBucketName('ac-bucket'),
      'ci',
      {now: () => nowMs}
    )
  })

  afterEach(async () => {
    await fs.rm(workspace, {recursive: true, force: true})
  })

  const baseEnv = () => ({
    S3_ARTIFACT_BUCKET: 'ac-bucket',
    S3_ARTIFACT_KEY_PREFIX: 'ci',
    GITHUB_WORKSPACE: workspace,
    GITHUB_REPOSITORY: 'org/app',
    GITHUB_RUN_ID: '500',
    GITHUB_RUN_ATTEMPT: '1'
  })

  it('AC-01: uploads a single file stripping parent directory and emits 53-bit ID, 64-hex digest, and s3 URL', async () => {
    await fs.mkdir(path.join(workspace, 'a/b'), {recursive: true})
    await fs.writeFile(path.join(workspace, 'a/b/hello.txt'), 'hi s3')

    const up = await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {name: 'my-art', path: 'a/b/hello.txt'},
      run: () => runUploadAction({createStore: () => store, now: () => nowMs})
    })

    expect(up.exitCode).toBe(0)
    expect(Number.isSafeInteger(Number(up.outputs['artifact-id']))).toBe(true)
    expect(up.outputs['artifact-digest']).toMatch(/^[0-9a-f]{64}$/)
    expect(up.outputs['artifact-url']).toMatch(
      /^s3:\/\/ac-bucket\/ci\/org\/app\/runs\/500\/blobs\/\d+$/
    )

    const outDir = path.join(workspace, 'dl-ac01')
    const dl = await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {name: 'my-art', path: outDir},
      run: () => runDownloadAction({createStore: () => store})
    })
    expect(dl.exitCode).toBe(0)
    expect(await fs.readFile(path.join(outDir, 'hello.txt'), 'utf8')).toBe('hi s3')
    await expect(fs.access(path.join(outDir, 'a'))).rejects.toThrow()
  })

  it('AC-02: preserves multi-path LCA relative structure and excludes negated glob files', async () => {
    await fs.mkdir(path.join(workspace, 'pkg-a/dist'), {recursive: true})
    await fs.mkdir(path.join(workspace, 'pkg-b/dist'), {recursive: true})
    await fs.writeFile(path.join(workspace, 'pkg-a/dist/index.js'), 'console.log(1)')
    await fs.writeFile(path.join(workspace, 'pkg-a/dist/sourcemap.map'), '{}')
    await fs.writeFile(path.join(workspace, 'pkg-b/dist/lib.js'), 'export const x=1')

    const up = await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {
        name: 'packages',
        path: 'pkg-a/dist/**\npkg-b/dist/**\n!**/sourcemap.map'
      },
      run: () => runUploadAction({createStore: () => store, now: () => nowMs})
    })
    expect(up.exitCode).toBe(0)

    const outDir = path.join(workspace, 'dl-ac02')
    const dl = await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {name: 'packages', path: outDir},
      run: () => runDownloadAction({createStore: () => store})
    })
    expect(dl.exitCode).toBe(0)
    expect(await fs.readFile(path.join(outDir, 'pkg-a/dist/index.js'), 'utf8')).toBe('console.log(1)')
    expect(await fs.readFile(path.join(outDir, 'pkg-b/dist/lib.js'), 'utf8')).toBe('export const x=1')
    await expect(fs.access(path.join(outDir, 'pkg-a/dist/sourcemap.map'))).rejects.toThrow()
  })

  it('AC-03: toggles hidden files and resolves valid symlinks while ignoring broken ones', async () => {
    await fs.mkdir(path.join(workspace, 'src/.hidden'), {recursive: true})
    await fs.writeFile(path.join(workspace, 'src/.env'), 'A=1')
    await fs.writeFile(path.join(workspace, 'src/.hidden/secret.txt'), 'shh')
    await fs.writeFile(path.join(workspace, 'target.txt'), 'linked-body')
    await fs.symlink(path.join(workspace, 'target.txt'), path.join(workspace, 'src/link.txt'))
    await fs.symlink(path.join(workspace, 'missing.txt'), path.join(workspace, 'src/broken.txt'))

    const upDefault = await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {name: 'no-hidden', path: 'src/**/*'},
      run: () => runUploadAction({createStore: () => store, now: () => nowMs})
    })
    expect(upDefault.exitCode).toBe(0)

    const dl1 = path.join(workspace, 'dl1')
    await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {name: 'no-hidden', path: dl1},
      run: () => runDownloadAction({createStore: () => store})
    })
    expect(await fs.readFile(path.join(dl1, 'link.txt'), 'utf8')).toBe('linked-body')
    await expect(fs.access(path.join(dl1, '.env'))).rejects.toThrow()
    await expect(fs.access(path.join(dl1, 'broken.txt'))).rejects.toThrow()

    const upHidden = await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {
        name: 'with-hidden',
        path: 'src/**/*',
        'include-hidden-files': 'true'
      },
      run: () => runUploadAction({createStore: () => store, now: () => nowMs})
    })
    expect(upHidden.exitCode).toBe(0)

    const dl2 = path.join(workspace, 'dl2')
    await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {name: 'with-hidden', path: dl2},
      run: () => runDownloadAction({createStore: () => store})
    })
    expect(await fs.readFile(path.join(dl2, '.env'), 'utf8')).toBe('A=1')
    expect(await fs.readFile(path.join(dl2, '.hidden/secret.txt'), 'utf8')).toBe('shh')
  })

  it('AC-04: handles if-no-files-found warn, error, and ignore', async () => {
    const warnRun = await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {name: 'empty', path: 'does-not-exist/**', 'if-no-files-found': 'warn'},
      run: () => runUploadAction({createStore: () => store, now: () => nowMs})
    })
    expect(warnRun.exitCode).toBe(0)
    expect(warnRun.warnings.length).toBeGreaterThan(0)
    expect(warnRun.outputs['artifact-id']).toBeUndefined()

    const errRun = await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {name: 'empty', path: 'does-not-exist/**', 'if-no-files-found': 'error'},
      run: () => runUploadAction({createStore: () => store, now: () => nowMs})
    })
    expect(errRun.exitCode).toBe(1)

    const ignoreRun = await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {name: 'empty', path: 'does-not-exist/**', 'if-no-files-found': 'ignore'},
      run: () => runUploadAction({createStore: () => store, now: () => nowMs})
    })
    expect(ignoreRun.exitCode).toBe(0)
    expect(ignoreRun.warnings).toHaveLength(0)
  })

  it('AC-05: supports archive:false raw single-file upload using file basename and rejecting multi-file matches', async () => {
    await fs.mkdir(path.join(workspace, 'dist'), {recursive: true})
    await fs.writeFile(path.join(workspace, 'dist/app.tar.gz'), 'raw-tar-gz-bytes')
    await fs.writeFile(path.join(workspace, 'dist/other.txt'), 'other')

    const ok = await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {name: 'ignored-name', path: 'dist/app.tar.gz', archive: 'false'},
      run: () => runUploadAction({createStore: () => store, now: () => nowMs})
    })
    expect(ok.exitCode).toBe(0)

    const outDir = path.join(workspace, 'dl-raw')
    const dl = await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {name: 'app.tar.gz', path: outDir},
      run: () => runDownloadAction({createStore: () => store})
    })
    expect(dl.exitCode).toBe(0)
    expect(await fs.readFile(path.join(outDir, 'app.tar.gz'), 'utf8')).toBe('raw-tar-gz-bytes')

    const multiFail = await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {name: 'ignored', path: 'dist/*', archive: 'false'},
      run: () => runUploadAction({createStore: () => store, now: () => nowMs})
    })
    expect(multiFail.exitCode).toBe(1)
  })

  it('AC-06: rejects duplicate name within same runAttempt when overwrite is false', async () => {
    await fs.writeFile(path.join(workspace, 'v1.txt'), 'v1')
    const first = await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {name: 'dup-art', path: 'v1.txt'},
      run: () => runUploadAction({createStore: () => store, now: () => nowMs})
    })
    expect(first.exitCode).toBe(0)

    await fs.writeFile(path.join(workspace, 'v1.txt'), 'v2')
    const second = await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {name: 'dup-art', path: 'v1.txt', overwrite: 'false'},
      run: () => runUploadAction({createStore: () => store, now: () => nowMs})
    })
    expect(second.exitCode).toBe(1)

    const outDir = path.join(workspace, 'dl-dup')
    await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {name: 'dup-art', path: outDir},
      run: () => runDownloadAction({createStore: () => store})
    })
    expect(await fs.readFile(path.join(outDir, 'v1.txt'), 'utf8')).toBe('v1')
  })

  it('AC-07: replaces artifact and cleans up old blob on overwrite: true', async () => {
    await fs.writeFile(path.join(workspace, 'data.txt'), 'first-content')
    const first = await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {name: 'ow-art', path: 'data.txt'},
      run: () => runUploadAction({createStore: () => store, now: () => nowMs})
    })
    expect(first.exitCode).toBe(0)
    const oldBlobKey = `ci/org/app/runs/500/blobs/${first.outputs['artifact-id']}`
    expect(store.hasBlob(oldBlobKey)).toBe(true)

    await fs.writeFile(path.join(workspace, 'data.txt'), 'second-content')
    const second = await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {name: 'ow-art', path: 'data.txt', overwrite: 'true'},
      run: () => runUploadAction({createStore: () => store, now: () => nowMs})
    })
    expect(second.exitCode).toBe(0)
    expect(second.outputs['artifact-id']).not.toBe(first.outputs['artifact-id'])
    expect(second.outputs['artifact-digest']).not.toBe(first.outputs['artifact-digest'])
    expect(store.hasBlob(oldBlobKey)).toBe(false)

    const outDir = path.join(workspace, 'dl-ow')
    await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {name: 'ow-art', path: outDir},
      run: () => runDownloadAction({createStore: () => store})
    })
    expect(await fs.readFile(path.join(outDir, 'data.txt'), 'utf8')).toBe('second-content')
  })

  it('AC-08: supports re-run failed jobs across runAttempt while keeping attempt 1 artifacts intact', async () => {
    await fs.writeFile(path.join(workspace, 'a.txt'), 'job-a-v1')
    await fs.writeFile(path.join(workspace, 'b.txt'), 'job-b-v1')

    expect(
      (
        await runActionBoundary({
          cwd: workspace,
          env: {...baseEnv(), GITHUB_RUN_ATTEMPT: '1'},
          inputs: {name: 'job-a-art', path: 'a.txt'},
          run: () => runUploadAction({createStore: () => store, now: () => nowMs})
        })
      ).exitCode
    ).toBe(0)
    expect(
      (
        await runActionBoundary({
          cwd: workspace,
          env: {...baseEnv(), GITHUB_RUN_ATTEMPT: '1'},
          inputs: {name: 'job-b-art', path: 'b.txt'},
          run: () => runUploadAction({createStore: () => store, now: () => nowMs})
        })
      ).exitCode
    ).toBe(0)

    await fs.writeFile(path.join(workspace, 'b.txt'), 'job-b-v2')
    const rerunUpload = await runActionBoundary({
      cwd: workspace,
      env: {...baseEnv(), GITHUB_RUN_ATTEMPT: '2'},
      inputs: {name: 'job-b-art', path: 'b.txt', overwrite: 'false'},
      run: () => runUploadAction({createStore: () => store, now: () => nowMs})
    })
    expect(rerunUpload.exitCode).toBe(0)

    const outDir = path.join(workspace, 'dl-rerun')
    const dlAll = await runActionBoundary({
      cwd: workspace,
      env: {...baseEnv(), GITHUB_RUN_ATTEMPT: '2'},
      inputs: {path: outDir},
      run: () => runDownloadAction({createStore: () => store})
    })
    expect(dlAll.exitCode).toBe(0)
    expect(await fs.readFile(path.join(outDir, 'job-a-art/a.txt'), 'utf8')).toBe('job-a-v1')
    expect(await fs.readFile(path.join(outDir, 'job-b-art/b.txt'), 'utf8')).toBe('job-b-v2')
  })

  it('AC-09 & AC-10: handles single download path expansion, multi-artifact separation/merge, and 1-item exception', async () => {
    await fs.writeFile(path.join(workspace, 'f1.txt'), 'one')
    await fs.writeFile(path.join(workspace, 'f2.txt'), 'two')

    await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {name: 'build-one', path: 'f1.txt'},
      run: () => runUploadAction({createStore: () => store, now: () => nowMs})
    })
    await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {name: 'build-two', path: 'f2.txt'},
      run: () => runUploadAction({createStore: () => store, now: () => nowMs})
    })

    const missing = await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {name: 'missing-art', path: path.join(workspace, 'out-miss')},
      run: () => runDownloadAction({createStore: () => store})
    })
    expect(missing.exitCode).toBe(1)

    const dlTilde = await runActionBoundary({
      cwd: workspace,
      env: {...baseEnv(), HOME: workspace},
      inputs: {name: 'build-one', path: '~/tilde-out'},
      run: () => runDownloadAction({createStore: () => store})
    })
    expect(dlTilde.exitCode).toBe(0)
    expect(dlTilde.outputs['download-path']).toBe(path.join(workspace, 'tilde-out'))
    expect(await fs.readFile(path.join(workspace, 'tilde-out/f1.txt'), 'utf8')).toBe('one')

    const splitDir = path.join(workspace, 'split-out')
    await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {pattern: 'build-*', path: splitDir, 'merge-multiple': 'false'},
      run: () => runDownloadAction({createStore: () => store})
    })
    expect(await fs.readFile(path.join(splitDir, 'build-one/f1.txt'), 'utf8')).toBe('one')
    expect(await fs.readFile(path.join(splitDir, 'build-two/f2.txt'), 'utf8')).toBe('two')

    const mergedDir = path.join(workspace, 'merged-out')
    await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {pattern: 'build-*', path: mergedDir, 'merge-multiple': 'true'},
      run: () => runDownloadAction({createStore: () => store})
    })
    expect(await fs.readFile(path.join(mergedDir, 'f1.txt'), 'utf8')).toBe('one')
    expect(await fs.readFile(path.join(mergedDir, 'f2.txt'), 'utf8')).toBe('two')

    const oneMatchDir = path.join(workspace, 'single-pattern-out')
    await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {pattern: 'build-one', path: oneMatchDir, 'merge-multiple': 'false'},
      run: () => runDownloadAction({createStore: () => store})
    })
    expect(await fs.readFile(path.join(oneMatchDir, 'f1.txt'), 'utf8')).toBe('one')
    await expect(fs.access(path.join(oneMatchDir, 'build-one'))).rejects.toThrow()

    const zeroMatchDir = path.join(workspace, 'zero-pattern-out')
    const zeroMatch = await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {pattern: 'does-not-match-*', path: zeroMatchDir},
      run: () => runDownloadAction({createStore: () => store})
    })
    expect(zeroMatch.exitCode).toBe(0)
    expect(zeroMatch.outputs['download-path']).toBe(zeroMatchDir)
    expect((await fs.stat(zeroMatchDir)).isDirectory()).toBe(true)
  })

  it('AC-11 & AC-12: downloads by artifact-ids with warnings/mutual exclusion and supports cross-repo/cross-run', async () => {
    await fs.writeFile(path.join(workspace, 'cross.txt'), 'from-other-run')
    const crossEnv = {
      ...baseEnv(),
      GITHUB_REPOSITORY: 'other-org/other-repo',
      GITHUB_RUN_ID: '99999'
    }
    const up = await runActionBoundary({
      cwd: workspace,
      env: crossEnv,
      inputs: {name: 'remote-art', path: 'cross.txt'},
      run: () => runUploadAction({createStore: () => store, now: () => nowMs})
    })
    const id1 = up.outputs['artifact-id'] ?? ''

    const mutuallyExclusive = await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {name: 'remote-art', 'artifact-ids': id1},
      run: () => runDownloadAction({createStore: () => store})
    })
    expect(mutuallyExclusive.exitCode).toBe(1)

    const outDir = path.join(workspace, 'cross-out')
    const dlById = await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {
        'artifact-ids': `${id1}, 999999999`,
        repository: 'other-org/other-repo',
        'run-id': '99999',
        'github-token': 'dummy-ignored-token',
        path: outDir
      },
      run: () => runDownloadAction({createStore: () => store})
    })
    expect(dlById.exitCode).toBe(0)
    expect(dlById.warnings.some(w => w.includes('999999999'))).toBe(true)
    expect(await fs.readFile(path.join(outDir, 'cross.txt'), 'utf8')).toBe('from-other-run')

    const noneFound = await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {
        'artifact-ids': '888888888',
        repository: 'other-org/other-repo',
        'run-id': '99999',
        path: outDir
      },
      run: () => runDownloadAction({createStore: () => store})
    })
    expect(noneFound.exitCode).toBe(1)
  })

  it('AC-13 & AC-14: supports skip-decompress and digest-mismatch modes (error, warn, info, ignore)', async () => {
    await fs.writeFile(path.join(workspace, 'item.txt'), 'valid-data')
    const up = await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {name: 'zip-art', path: 'item.txt'},
      run: () => runUploadAction({createStore: () => store, now: () => nowMs})
    })
    expect(up.exitCode).toBe(0)

    const skipDir = path.join(workspace, 'skip-out')
    const skipDl = await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {name: 'zip-art', path: skipDir, 'skip-decompress': 'true'},
      run: () => runDownloadAction({createStore: () => store})
    })
    expect(skipDl.exitCode).toBe(0)
    const zipBytes = await fs.readFile(path.join(skipDir, 'zip-art.zip'))
    const verifyExtractDir = path.join(workspace, 'verify-zip')
    await extractArchiveStream(zipBytes, verifyExtractDir)
    expect(await fs.readFile(path.join(verifyExtractDir, 'item.txt'), 'utf8')).toBe('valid-data')

    const blobKey = `ci/org/app/runs/500/blobs/${up.outputs['artifact-id']}`
    const tamperedZip = createZipWithEntry('tampered.txt', 'evil')
    store.setRawBlobForTesting(blobKey, tamperedZip)

    const errDir = path.join(workspace, 'err-digest')
    const errDl = await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {name: 'zip-art', path: errDir},
      run: () => runDownloadAction({createStore: () => store})
    })
    expect(errDl.exitCode).toBe(1)
    await expect(fs.access(path.join(errDir, 'tampered.txt'))).rejects.toThrow()

    for (const mode of ['warn', 'info', 'ignore'] as const) {
      const modeDir = path.join(workspace, `mode-${mode}`)
      const res = await runActionBoundary({
        cwd: workspace,
        env: baseEnv(),
        inputs: {name: 'zip-art', path: modeDir, 'digest-mismatch': mode},
        run: () => runDownloadAction({createStore: () => store})
      })
      expect(res.exitCode).toBe(0)
      if (mode === 'warn') {
        expect(res.warnings.length).toBeGreaterThan(0)
      } else {
        expect(res.warnings).toHaveLength(0)
      }
      expect(await fs.readFile(path.join(modeDir, 'tampered.txt'), 'utf8')).toBe('evil')
    }
  })

  it('AC-15 & AC-16: blocks Zip-Slip payloads at download and rejects invalid artifact names before S3', async () => {
    const evilZip = createZipWithEntry('../../escape.txt', 'bad')
    const evilDigest = parseSha256Digest(
      `sha256:${createHash('sha256').update(evilZip).digest('hex')}`
    )
    const scope = parseRunScope({repository: 'org/app', runId: 500, runAttempt: 1})
    const evilBlobKey = 'ci/org/app/runs/500/blobs/98765'
    store.setRawBlobForTesting(evilBlobKey, evilZip)
    const evilManifest: ArtifactManifestV1 = {
      schemaVersion: 1,
      id: parseArtifactId('98765'),
      name: parseArtifactName('evil-art'),
      repository: 'org/app',
      runId: 500,
      runAttempt: 1,
      blobKey: evilBlobKey,
      size: evilZip.length,
      digest: evilDigest,
      archived: true,
      rawFileName: 'evil-art.zip',
      contentType: 'application/zip',
      createdAt: new Date(nowMs).toISOString()
    }
    await store.commitManifest(scope, evilManifest, {mode: 'create-only'})

    const safeDest = path.join(workspace, 'nested/dest')
    const dlEvil = await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {name: 'evil-art', path: safeDest},
      run: () => runDownloadAction({createStore: () => store})
    })
    expect(dlEvil.exitCode).toBe(1)
    await expect(fs.access(path.join(workspace, 'escape.txt'))).rejects.toThrow()

    await fs.writeFile(path.join(workspace, 'good.txt'), 'ok')
    const badName = await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {name: 'bad/name', path: 'good.txt'},
      run: () => runUploadAction({createStore: () => store, now: () => nowMs})
    })
    expect(badName.exitCode).toBe(1)
  })

  it('AC-17 & AC-18: masks secret inputs, records retentionDays/expiresAt, and hides expired artifacts', async () => {
    await fs.writeFile(path.join(workspace, 'ret.txt'), 'keep-7d')
    const up = await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {
        name: 'retained',
        path: 'ret.txt',
        'retention-days': '7',
        'access-key-id': 'AKIA_TEST',
        'secret-access-key': 'SECRET_VALUE_123',
        'session-token': 'SESSION_TOKEN_456'
      },
      run: () => runUploadAction({createStore: () => store, now: () => nowMs})
    })
    expect(up.exitCode).toBe(0)
    expect(up.maskedSecrets).toContain('SECRET_VALUE_123')
    expect(up.maskedSecrets).toContain('SESSION_TOKEN_456')

    const scope = parseRunScope({repository: 'org/app', runId: 500, runAttempt: 1})
    const meta = await store.getManifestWithMeta(scope, parseArtifactName('retained'))
    expect(meta?.manifest.retentionDays).toBe(7)
    expect(meta?.manifest.expiresAt).toBe(
      new Date(nowMs + 7 * 24 * 60 * 60 * 1000).toISOString()
    )
    expect(store.getBlobTags(`ci/org/app/runs/500/blobs/${up.outputs['artifact-id']}`)).toBe(
      's3-artifact-retention-days=7'
    )

    nowMs += 8 * 24 * 60 * 60 * 1000
    const expiredDl = await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {name: 'retained', path: path.join(workspace, 'exp-out')},
      run: () => runDownloadAction({createStore: () => store})
    })
    expect(expiredDl.exitCode).toBe(1)

    await fs.writeFile(path.join(workspace, 'ret.txt'), 'fresh-after-expiry')
    const reuploadAfterExpiry = await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {name: 'retained', path: 'ret.txt', overwrite: 'false'},
      run: () => runUploadAction({createStore: () => store, now: () => nowMs})
    })
    expect(reuploadAfterExpiry.exitCode).toBe(0)
  })

  it('AC-19: keeps failed mid-stream uploads invisible because no manifest is committed', async () => {
    await fs.writeFile(path.join(workspace, 'fail.txt'), 'data')
    const failingStore = {
      getManifestWithMeta: store.getManifestWithMeta.bind(store),
      putBlobStream: () =>
        Promise.reject(new Error('Simulated network drop mid-stream')),
      commitManifest: store.commitManifest.bind(store),
      listManifests: store.listManifests.bind(store),
      openBlobStream: store.openBlobStream.bind(store),
      deleteBlobBestEffort: store.deleteBlobBestEffort.bind(store),
      deleteArtifact: store.deleteArtifact.bind(store),
      presignGetObject: store.presignGetObject.bind(store)
    }

    const failedUpload = await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {name: 'broken-upload', path: 'fail.txt'},
      run: () =>
        runUploadAction({createStore: () => failingStore, now: () => nowMs})
    })
    expect(failedUpload.exitCode).toBe(1)

    const dl = await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {name: 'broken-upload', path: path.join(workspace, 'never')},
      run: () => runDownloadAction({createStore: () => store})
    })
    expect(dl.exitCode).toBe(1)
  })
})
