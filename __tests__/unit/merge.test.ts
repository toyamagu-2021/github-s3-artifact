import {afterEach, beforeEach, describe, expect, it} from 'vitest'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {runActionBoundary} from '../helpers/action-harness.js'
import {runDownloadAction} from '../../src/download/action.js'
import {runMergeAction} from '../../src/merge/action.js'
import {parseArtifactName, parseBucketName, parseRunScope} from '../../src/shared/types.js'
import {InMemoryArtifactStore} from '../../src/storage/memory-store.js'
import {runUploadAction} from '../../src/upload/action.js'

describe('merge sub-action', () => {
  let workspace: string
  let nowMs: number
  let store: InMemoryArtifactStore

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 's3-art-merge-'))
    nowMs = Date.parse('2026-06-01T00:00:00.000Z')
    store = new InMemoryArtifactStore(
      parseBucketName('merge-bucket'),
      'ci',
      {now: () => nowMs}
    )
  })

  afterEach(async () => {
    await fs.rm(workspace, {recursive: true, force: true})
  })

  const baseEnv = () => ({
    S3_ARTIFACT_BUCKET: 'merge-bucket',
    S3_ARTIFACT_KEY_PREFIX: 'ci',
    GITHUB_WORKSPACE: workspace,
    GITHUB_REPOSITORY: 'org/app',
    GITHUB_RUN_ID: '500',
    GITHUB_RUN_ATTEMPT: '1'
  })

  const scope = () =>
    parseRunScope({repository: 'org/app', runId: '500', runAttempt: '1'})

  async function uploadFile(
    name: string,
    relativePath: string,
    body: string,
    extra: Record<string, string> = {}
  ): Promise<void> {
    const absolute = path.join(workspace, relativePath)
    await fs.mkdir(path.dirname(absolute), {recursive: true})
    await fs.writeFile(absolute, body)
    const up = await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {name, path: relativePath, ...extra},
      run: () => runUploadAction({createStore: () => store, now: () => nowMs})
    })
    expect(up.exitCode).toBe(0)
  }

  async function downloadTo(name: string, relativeDest: string): Promise<string> {
    const dest = path.join(workspace, relativeDest)
    const dl = await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {name, path: dest},
      run: () => runDownloadAction({createStore: () => store})
    })
    expect(dl.exitCode).toBe(0)
    return dest
  }

  it('combines matched artifacts into one archive and leaves the sources', async () => {
    await uploadFile('pkg-a', 'a.txt', 'alpha')
    await uploadFile('pkg-b', 'b.txt', 'beta')
    await uploadFile('notes', 'notes.txt', 'skip-me')

    const merged = await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {
        name: 'merged-pkgs',
        pattern: 'pkg-*',
        'retention-days': '7',
        'compression-level': '0'
      },
      run: () => runMergeAction({createStore: () => store, now: () => nowMs})
    })

    expect(merged.exitCode).toBe(0)
    expect(merged.outputs['artifact-digest']).toMatch(/^[0-9a-f]{64}$/)
    expect(merged.outputs['artifact-url']).toMatch(
      /^s3:\/\/merge-bucket\/ci\/org\/app\/runs\/500\/blobs\/\d+$/
    )

    const outDir = await downloadTo('merged-pkgs', 'out-combined')
    expect(await fs.readFile(path.join(outDir, 'a.txt'), 'utf8')).toBe('alpha')
    expect(await fs.readFile(path.join(outDir, 'b.txt'), 'utf8')).toBe('beta')
    await expect(fs.access(path.join(outDir, 'notes.txt'))).rejects.toThrow()

    const stored = await store.getManifestWithMeta(scope(), parseArtifactName('merged-pkgs'))
    expect(stored?.manifest.retentionDays).toBe(7)
    expect(await store.getManifestWithMeta(scope(), parseArtifactName('pkg-a'))).not.toBeNull()
    expect(await store.getManifestWithMeta(scope(), parseArtifactName('pkg-b'))).not.toBeNull()
  })

  it('extracts each artifact into its own directory when separate-directories is true', async () => {
    await uploadFile('left', 'same.txt', 'from-left')
    await uploadFile('right', 'same.txt', 'from-right')

    const merged = await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {
        name: 'split-merge',
        pattern: '*',
        'separate-directories': 'true'
      },
      run: () => runMergeAction({createStore: () => store, now: () => nowMs})
    })
    expect(merged.exitCode).toBe(0)

    const outDir = await downloadTo('split-merge', 'out-split')
    expect(await fs.readFile(path.join(outDir, 'left/same.txt'), 'utf8')).toBe(
      'from-left'
    )
    expect(await fs.readFile(path.join(outDir, 'right/same.txt'), 'utf8')).toBe(
      'from-right'
    )
  })

  it('deletes source manifests before their blobs when delete-merged is true', async () => {
    await uploadFile('pkg-a', 'a.txt', 'alpha')
    await uploadFile('pkg-b', 'b.txt', 'beta')
    const sourceA = await store.getManifestWithMeta(scope(), parseArtifactName('pkg-a'))
    const sourceB = await store.getManifestWithMeta(scope(), parseArtifactName('pkg-b'))
    expect(sourceA).not.toBeNull()
    expect(sourceB).not.toBeNull()

    const manifestVisibleAtBlobDelete: Record<string, boolean> = {}
    const origDeleteBlob = store.deleteBlobBestEffort.bind(store)
    store.deleteBlobBestEffort = async (blobKey: string) => {
      if (blobKey === sourceA!.manifest.blobKey) {
        manifestVisibleAtBlobDelete['pkg-a'] =
          (await store.getManifestWithMeta(scope(), parseArtifactName('pkg-a'))) !== null
      }
      if (blobKey === sourceB!.manifest.blobKey) {
        manifestVisibleAtBlobDelete['pkg-b'] =
          (await store.getManifestWithMeta(scope(), parseArtifactName('pkg-b'))) !== null
      }
      await origDeleteBlob(blobKey)
    }

    const merged = await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {name: 'kept', pattern: 'pkg-*', 'delete-merged': 'true'},
      run: () => runMergeAction({createStore: () => store, now: () => nowMs})
    })
    expect(merged.exitCode).toBe(0)
    expect(merged.stdout).toContain('2 artifact(s) have been deleted')
    expect(manifestVisibleAtBlobDelete).toEqual({'pkg-a': false, 'pkg-b': false})

    expect(await store.getManifestWithMeta(scope(), parseArtifactName('pkg-a'))).toBeNull()
    expect(await store.getManifestWithMeta(scope(), parseArtifactName('pkg-b'))).toBeNull()
    expect(store.hasBlob(sourceA!.manifest.blobKey)).toBe(false)
    expect(store.hasBlob(sourceB!.manifest.blobKey)).toBe(false)
    expect(await store.getManifestWithMeta(scope(), parseArtifactName('kept'))).not.toBeNull()

    const outDir = await downloadTo('kept', 'out-kept')
    expect(await fs.readFile(path.join(outDir, 'a.txt'), 'utf8')).toBe('alpha')
  })

  it('drops hidden files unless include-hidden-files is true', async () => {
    await uploadFile('with-dot', '.env', 'secret', {'include-hidden-files': 'true'})

    const hidden = await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {name: 'visible-only', pattern: 'with-dot'},
      run: () => runMergeAction({createStore: () => store, now: () => nowMs})
    })
    expect(hidden.exitCode).not.toBe(0)
    expect(`${hidden.stdout}\n${hidden.stderr}`).toContain('No files were found')

    const shown = await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {
        name: 'with-hidden',
        pattern: 'with-dot',
        'include-hidden-files': 'true'
      },
      run: () => runMergeAction({createStore: () => store, now: () => nowMs})
    })
    expect(shown.exitCode).toBe(0)
    const outDir = await downloadTo('with-hidden', 'out-hidden')
    expect(await fs.readFile(path.join(outDir, '.env'), 'utf8')).toBe('secret')
  })

  it('fails when the pattern matches nothing', async () => {
    await uploadFile('pkg-a', 'a.txt', 'alpha')
    const merged = await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {name: 'empty', pattern: 'missing-*'},
      run: () => runMergeAction({createStore: () => store, now: () => nowMs})
    })
    expect(merged.exitCode).not.toBe(0)
    expect(`${merged.stdout}\n${merged.stderr}`).toContain(
      "No artifacts found matching pattern 'missing-*'"
    )
    expect(await store.getManifestWithMeta(scope(), parseArtifactName('empty'))).toBeNull()
  })

  it('does not interleave bytes when overlapping files merge with separate-directories false', async () => {
    const bigPayload = 'A'.repeat(256 * 1024)
    const smallPayload = 'B'.repeat(16 * 1024)
    await uploadFile('overlap-a', 'shared.bin', bigPayload)
    await uploadFile('overlap-b', 'shared.bin', smallPayload)

    const merged = await runActionBoundary({
      cwd: workspace,
      env: baseEnv(),
      inputs: {
        name: 'merged-overlap',
        pattern: 'overlap-*',
        'separate-directories': 'false'
      },
      run: () => runMergeAction({createStore: () => store, now: () => nowMs})
    })
    expect(merged.exitCode).toBe(0)

    const outDir = await downloadTo('merged-overlap', 'out-overlap')
    const content = await fs.readFile(path.join(outDir, 'shared.bin'), 'utf8')
    expect(content === bigPayload || content === smallPayload).toBe(true)
  })

  it('supports presigned artifact-url via env fallback in merge', async () => {
    await uploadFile('pkg-a', 'a.txt', 'alpha')
    store.presignGetObject = (blobKey: string, expiresInSeconds: number) =>
      Promise.resolve(
        `https://signed.example/${blobKey}?X-Amz-Expires=${expiresInSeconds}`
      )

    const merged = await runActionBoundary({
      cwd: workspace,
      env: {
        ...baseEnv(),
        S3_ARTIFACT_URL_FORMAT: 'presigned',
        S3_ARTIFACT_PRESIGN_EXPIRES_SECONDS: '180'
      },
      inputs: {name: 'merged-signed', pattern: 'pkg-*'},
      run: () => runMergeAction({createStore: () => store, now: () => nowMs})
    })
    expect(merged.exitCode).toBe(0)
    expect(merged.outputs['artifact-url']).toMatch(
      /^https:\/\/signed\.example\/ci\/org\/app\/runs\/500\/blobs\/\d+\?X-Amz-Expires=180$/
    )
  })
})
