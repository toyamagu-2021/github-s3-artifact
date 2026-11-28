import {describe, expect, it} from 'vitest'
import {Readable} from 'node:stream'
import {
  parseArtifactId,
  parseArtifactName,
  parseBucketName,
  parseManifestJson,
  parseRunScope,
  parseSha256Digest
} from '../../src/shared/types.js'
import {
  validateArtifactName,
  validateRelativeArchivePath
} from '../../src/shared/validation.js'
import {parseS3BackendConfig} from '../../src/shared/s3-config.js'
import {generateArtifactId} from '../../src/shared/ids.js'
import {ArtifactConflictError} from '../../src/shared/errors.js'
import {InMemoryArtifactStore} from '../../src/storage/memory-store.js'
import {
  buildBlobKey,
  buildManifestKey,
  buildRunBasePrefix
} from '../../src/storage/store.js'
import {S3ArtifactStore} from '../../src/storage/s3-store.js'
import type {S3Client} from '@aws-sdk/client-s3'

describe('domain types and boundary validation', () => {
  it('validates artifact names against NTFS, dot segments, whitespace, and path separators (AC-16)', () => {
    for (const bad of [
      '',
      '   ',
      '.',
      '..',
      ' . ',
      ' .. ',
      'a/b',
      'a\\b',
      'a:b',
      'a*b',
      'a?b',
      'a"b',
      'a<b',
      'a>b',
      'a|b',
      'a\rb',
      'a\nb'
    ]) {
      expect(() => validateArtifactName(bad)).toThrow()
    }
    expect(parseArtifactName('build-linux-x64')).toBe('build-linux-x64')
    expect(parseArtifactName('v1..2')).toBe('v1..2')
    expect(parseArtifactName('m¥ñðrmål')).toBe('m¥ñðrmål')
  })

  it('validates archive relative file paths against NTFS forbidden characters (AC-16)', () => {
    for (const bad of ['', 'dir/a:b.txt', 'dir/a*b.txt', 'dir/a?b.txt', 'dir/a"b.txt', 'dir/a<b.txt', 'dir/a>b.txt', 'dir/a|b.txt', 'dir/a\rb.txt', 'dir/a\nb.txt']) {
      expect(() => validateRelativeArchivePath(bad)).toThrow()
    }
    expect(() => validateRelativeArchivePath('pkg-a/dist/index.js')).not.toThrow()
  })

  it('validates BucketName, ArtifactId, Sha256Digest, RunScope, and Manifest JSON', () => {
    expect(parseBucketName('my-artifacts-bucket')).toBe('my-artifacts-bucket')
    expect(() => parseBucketName('  ')).toThrow()
    expect(() => parseBucketName('bad/bucket')).toThrow()

    expect(parseArtifactId('12345')).toBe('12345')
    expect(() => parseArtifactId('0')).toThrow()
    expect(() => parseArtifactId('abc')).toThrow()
    expect(() => parseArtifactId('9007199254740992')).toThrow()

    const validHex = 'a'.repeat(64)
    expect(parseSha256Digest(`sha256:${validHex}`)).toBe(`sha256:${validHex}`)
    expect(() => parseSha256Digest(validHex)).toThrow()
    expect(() => parseSha256Digest('sha256:xyz')).toThrow()

    const scope = parseRunScope({
      repository: 'octo/repo',
      runId: '42',
      runAttempt: '2'
    })
    expect(scope).toEqual({
      repositoryOwner: 'octo',
      repositoryName: 'repo',
      runId: 42,
      runAttempt: 2
    })
    expect(() =>
      parseRunScope({repository: 'bad', runId: '42', runAttempt: '1'})
    ).toThrow()

    const rawManifest = JSON.stringify({
      schemaVersion: 1,
      id: '9001',
      name: 'dist',
      repository: 'octo/repo',
      runId: 42,
      runAttempt: 1,
      blobKey: 'octo/repo/runs/42/blobs/9001',
      size: 128,
      digest: `sha256:${validHex}`,
      archived: true,
      rawFileName: 'dist.zip',
      contentType: 'application/zip',
      createdAt: '2026-01-01T00:00:00.000Z'
    })
    expect(parseManifestJson(rawManifest).id).toBe('9001')
    expect(() => parseManifestJson('{"schemaVersion":2}')).toThrow()
  })

  it('generates unique 53-bit safe integer ArtifactIds', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 100; i++) {
      const id = generateArtifactId()
      const num = Number(id)
      expect(Number.isSafeInteger(num)).toBe(true)
      expect(num).toBeGreaterThan(0)
      expect(seen.has(id)).toBe(false)
      seen.add(id)
    }
  })
})

describe('S3 config parser (AC-17)', () => {
  it('reads env fallbacks and prefers explicit inputs over env', () => {
    const masked: string[] = []
    const parsedFromEnv = parseS3BackendConfig(
      {},
      {
        S3_ARTIFACT_BUCKET: 'env-bucket',
        S3_ARTIFACT_KEY_PREFIX: '/ci/artifacts/',
        AWS_REGION: 'eu-west-1',
        AWS_ENDPOINT_URL_S3: 'https://r2.example.com',
        S3_ARTIFACT_FORCE_PATH_STYLE: 'true'
      },
      s => masked.push(s)
    )
    expect(parsedFromEnv).toEqual({
      bucket: 'env-bucket',
      keyPrefix: 'ci/artifacts',
      region: 'eu-west-1',
      endpoint: 'https://r2.example.com',
      forcePathStyle: true,
      credentials: undefined
    })

    const overridden = parseS3BackendConfig(
      {
        bucket: 'input-bucket',
        keyPrefix: 'custom/',
        region: 'ap-northeast-1',
        endpoint: 'http://127.0.0.1:9000',
        forcePathStyle: 'false',
        accessKeyId: 'ak',
        secretAccessKey: 'sk',
        sessionToken: 'tok'
      },
      {
        S3_ARTIFACT_BUCKET: 'env-bucket',
        S3_ARTIFACT_KEY_PREFIX: 'env-prefix',
        S3_ARTIFACT_REGION: 'us-west-2',
        S3_ARTIFACT_ENDPOINT: 'https://ignored.example.com',
        S3_ARTIFACT_FORCE_PATH_STYLE: 'true'
      },
      s => masked.push(s)
    )
    expect(overridden).toEqual({
      bucket: 'input-bucket',
      keyPrefix: 'custom',
      region: 'ap-northeast-1',
      endpoint: 'http://127.0.0.1:9000',
      forcePathStyle: false,
      credentials: {
        accessKeyId: 'ak',
        secretAccessKey: 'sk',
        sessionToken: 'tok'
      }
    })
    expect(masked).toContain('sk')
    expect(masked).toContain('tok')
  })

  it('defaults region to auto when endpoint is set and us-east-1 otherwise', () => {
    const withEndpoint = parseS3BackendConfig(
      {},
      {
        S3_ARTIFACT_BUCKET: 'b',
        S3_ARTIFACT_ENDPOINT: 'https://r2.example.com'
      },
      () => {}
    )
    expect(withEndpoint.region).toBe('auto')

    const awsDefault = parseS3BackendConfig(
      {},
      {S3_ARTIFACT_BUCKET: 'b'},
      () => {}
    )
    expect(awsDefault.region).toBe('us-east-1')
  })

  it('rejects partial explicit credentials', () => {
    expect(() =>
      parseS3BackendConfig(
        {bucket: 'b', accessKeyId: 'only-ak'},
        {},
        () => {}
      )
    ).toThrow()
  })
})

describe('key layout and InMemoryArtifactStore', () => {
  const scope = parseRunScope({
    repository: 'owner/repo',
    runId: '101',
    runAttempt: '1'
  })

  it('builds normalized S3 object keys', () => {
    expect(buildRunBasePrefix('ci/artifacts', scope)).toBe(
      'ci/artifacts/owner/repo/runs/101'
    )
    expect(buildBlobKey('', scope, parseArtifactId('777'))).toBe(
      'owner/repo/runs/101/blobs/777'
    )
    expect(buildManifestKey('prefix', scope, parseArtifactName('build 1.0'))).toBe(
      'prefix/owner/repo/runs/101/manifests/build%201.0.json'
    )
  })

  it('enforces create-only, compare-and-swap, unconditional, and expiration visibility', async () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z')
    const store = new InMemoryArtifactStore(parseBucketName('test-bucket'), '', {
      now: () => now
    })

    const blob = await store.putBlobStream({
      scope,
      id: parseArtifactId('10'),
      body: Readable.from([Buffer.from('hello world')]),
      contentType: 'application/zip'
    })
    expect(blob.size).toBe(11)
    expect(blob.artifactUrl).toBe(
      's3://test-bucket/owner/repo/runs/101/blobs/10'
    )

    const manifest1 = {
      schemaVersion: 1 as const,
      id: parseArtifactId('10'),
      name: parseArtifactName('art'),
      repository: 'owner/repo' as const,
      runId: 101,
      runAttempt: 1,
      blobKey: blob.blobKey,
      size: blob.size,
      digest: blob.digest,
      archived: true,
      rawFileName: 'art.zip',
      contentType: 'application/zip',
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 1000).toISOString()
    }

    await store.commitManifest(scope, manifest1, {mode: 'create-only'})
    await expect(
      store.commitManifest(scope, manifest1, {mode: 'create-only'})
    ).rejects.toBeInstanceOf(ArtifactConflictError)

    const fetched = await store.getManifestWithMeta(scope, manifest1.name)
    expect(fetched?.etag).toBeTruthy()
    expect(await store.listManifests(scope)).toHaveLength(1)

    await expect(
      store.commitManifest(scope, manifest1, {
        mode: 'compare-and-swap',
        etag: '"wrong-etag"'
      })
    ).rejects.toBeInstanceOf(ArtifactConflictError)

    now += 2000
    const expiredLookup = await store.getManifestWithMeta(scope, manifest1.name)
    expect(expiredLookup?.expired).toBe(true)
    expect(expiredLookup?.etag).toBeTruthy()
    expect(await store.listManifests(scope)).toHaveLength(0)

    await expect(
      store.commitManifest(
        scope,
        {...manifest1, id: parseArtifactId('11'), expiresAt: undefined},
        {mode: 'create-only'}
      )
    ).rejects.toBeInstanceOf(ArtifactConflictError)

    await store.commitManifest(
      scope,
      {
        ...manifest1,
        id: parseArtifactId('11'),
        expiresAt: undefined
      },
      {mode: 'compare-and-swap', etag: expiredLookup!.etag!}
    )
    expect((await store.listManifests(scope)).map(m => m.id)).toEqual(['11'])
  })

  it('falls back gracefully when tagging or conditional PUT is unsupported on S3', async () => {
    const calls: Array<{name: string; input: Record<string, unknown>}> = []
    const warnings: string[] = []
    const fakeClient = {
      send: async (cmd: {constructor: {name: string}; input: Record<string, unknown>}) => {
        const name = cmd.constructor.name
        calls.push({name, input: cmd.input})
        if (name === 'PutObjectCommand' && cmd.input.Tagging) {
          const err = new Error('Not implemented tagging')
          err.name = 'NotImplemented'
          throw err
        }
        if (name === 'PutObjectCommand' && cmd.input.IfNoneMatch) {
          const err = new Error('Conditional not implemented')
          err.name = 'NotImplemented'
          throw err
        }
        return {}
      }
    } as unknown as S3Client

    const store = new S3ArtifactStore(
      {
        bucket: parseBucketName('b'),
        keyPrefix: '',
        region: 'us-east-1',
        forcePathStyle: true
      },
      {
        client: fakeClient,
        warn: msg => warnings.push(msg),
        now: () => Date.parse('2026-01-01T00:00:00.000Z')
      }
    )

    const validHex = 'b'.repeat(64)
    await store.commitManifest(
      scope,
      {
        schemaVersion: 1,
        id: parseArtifactId('55'),
        name: parseArtifactName('tagged'),
        repository: 'owner/repo',
        runId: 101,
        runAttempt: 1,
        blobKey: 'owner/repo/runs/101/blobs/55',
        size: 5,
        digest: parseSha256Digest(`sha256:${validHex}`),
        archived: true,
        rawFileName: 'tagged.zip',
        contentType: 'application/zip',
        retentionDays: 7,
        createdAt: '2026-01-01T00:00:00.000Z'
      },
      {mode: 'create-only'}
    )

    expect(warnings.some(w => w.includes('tagging'))).toBe(true)
    expect(warnings.some(w => w.includes('conditional write'))).toBe(true)
    const lastPut = calls[calls.length - 1]
    expect(lastPut?.input.Tagging).toBeUndefined()
    expect(lastPut?.input.IfNoneMatch).toBeUndefined()
  })

  it('skips expired manifests before applying ACTIONS_ARTIFACT_MAX_ARTIFACT_COUNT on S3', async () => {
    const now = Date.parse('2026-06-01T00:00:00.000Z')
    const validHex = 'c'.repeat(64)
    const makeManifestJson = (id: string, name: string, expiresAt?: string) =>
      JSON.stringify({
        schemaVersion: 1,
        id,
        name,
        repository: 'owner/repo',
        runId: 101,
        runAttempt: 1,
        blobKey: `owner/repo/runs/101/blobs/${id}`,
        size: 5,
        digest: `sha256:${validHex}`,
        archived: true,
        rawFileName: `${name}.zip`,
        contentType: 'application/zip',
        createdAt: '2026-05-01T00:00:00.000Z',
        ...(expiresAt ? {expiresAt} : {})
      })

    const objects: Record<string, string> = {
      'owner/repo/runs/101/manifests/a-expired.json': makeManifestJson(
        '1',
        'a-expired',
        '2026-05-15T00:00:00.000Z'
      ),
      'owner/repo/runs/101/manifests/b-live.json': makeManifestJson('2', 'b-live'),
      'owner/repo/runs/101/manifests/c-expired.json': makeManifestJson(
        '3',
        'c-expired',
        '2026-05-20T00:00:00.000Z'
      )
    }
    const getCalls: string[] = []
    const warnings: string[] = []

    const fakeClient = {
      send: async (cmd: {constructor: {name: string}; input: Record<string, unknown>}) => {
        const name = cmd.constructor.name
        if (name === 'ListObjectsV2Command') {
          return {
            Contents: Object.keys(objects)
              .sort()
              .map(Key => ({Key})),
            IsTruncated: false
          }
        }
        if (name === 'GetObjectCommand') {
          const key = String(cmd.input.Key)
          getCalls.push(key)
          const raw = objects[key]
          if (!raw) {
            const err = new Error('NoSuchKey')
            err.name = 'NoSuchKey'
            throw err
          }
          return {Body: {transformToString: () => Promise.resolve(raw)}}
        }
        throw new Error(`Unexpected S3 command: ${name}`)
      }
    } as unknown as S3Client

    const store = new S3ArtifactStore(
      {
        bucket: parseBucketName('b'),
        keyPrefix: '',
        region: 'us-east-1',
        forcePathStyle: true
      },
      {
        client: fakeClient,
        warn: msg => warnings.push(msg),
        now: () => now,
        env: {ACTIONS_ARTIFACT_MAX_ARTIFACT_COUNT: '1'}
      }
    )

    const listed = await store.listManifests(scope)
    expect(listed.map(m => m.name)).toEqual(['b-live'])
    expect(warnings).toEqual([])

    objects['owner/repo/runs/101/manifests/d-live.json'] = makeManifestJson(
      '4',
      'd-live'
    )
    objects['owner/repo/runs/101/manifests/e-live.json'] = makeManifestJson(
      '5',
      'e-live'
    )
    getCalls.length = 0
    const capped = await store.listManifests(scope)
    expect(capped.map(m => m.name)).toEqual(['b-live'])
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('Artifact list exceeded the limit of 1')
    expect(getCalls).not.toContain('owner/repo/runs/101/manifests/e-live.json')

    const probeWarnings: string[] = []
    const probeObjects: Record<string, string> = {
      'owner/repo/runs/101/manifests/a-live.json': makeManifestJson('10', 'a-live'),
      'owner/repo/runs/101/manifests/b-live.json': makeManifestJson('11', 'b-live'),
      'owner/repo/runs/101/manifests/c-corrupt.json': '{corrupt-json'
    }
    const probeClient = {
      send: async (cmd: {constructor: {name: string}; input: Record<string, unknown>}) => {
        if (cmd.constructor.name === 'ListObjectsV2Command') {
          return {
            Contents: Object.keys(probeObjects)
              .sort()
              .map(Key => ({Key})),
            IsTruncated: false
          }
        }
        if (cmd.constructor.name === 'GetObjectCommand') {
          const raw = probeObjects[String(cmd.input.Key)]
          return {Body: {transformToString: () => Promise.resolve(raw ?? '')}}
        }
        throw new Error('Unexpected command')
      }
    } as unknown as S3Client

    const probeStore = new S3ArtifactStore(
      {
        bucket: parseBucketName('b'),
        keyPrefix: '',
        region: 'us-east-1',
        forcePathStyle: true
      },
      {
        client: probeClient,
        warn: msg => probeWarnings.push(msg),
        now: () => now,
        env: {ACTIONS_ARTIFACT_MAX_ARTIFACT_COUNT: '2'}
      }
    )
    const probeListed = await probeStore.listManifests(scope)
    expect(probeListed.map(m => m.name)).toEqual(['a-live', 'b-live'])
    expect(probeWarnings).toHaveLength(1)
    expect(probeWarnings[0]).toContain('Artifact list exceeded the limit of 2')
  })

  it('deletes manifest object before blob object in S3ArtifactStore.deleteArtifact and tolerates blob delete errors', async () => {
    const validHex = 'd'.repeat(64)
    const manifestKey = 'owner/repo/runs/101/manifests/to-delete.json'
    const blobKey = 'owner/repo/runs/101/blobs/888'
    const deletedKeys: string[] = []

    const fakeClient = {
      send: async (cmd: {constructor: {name: string}; input: Record<string, unknown>}) => {
        const name = cmd.constructor.name
        if (name === 'GetObjectCommand') {
          return {
            ETag: '"e1"',
            Body: {
              transformToString: () =>
                Promise.resolve(
                  JSON.stringify({
                    schemaVersion: 1,
                    id: '888',
                    name: 'to-delete',
                    repository: 'owner/repo',
                    runId: 101,
                    runAttempt: 1,
                    blobKey,
                    size: 4,
                    digest: `sha256:${validHex}`,
                    archived: true,
                    rawFileName: 'to-delete.zip',
                    contentType: 'application/zip',
                    createdAt: '2026-01-01T00:00:00.000Z'
                  })
                )
            }
          }
        }
        if (name === 'DeleteObjectCommand') {
          const key = String(cmd.input.Key)
          deletedKeys.push(key)
          if (key === blobKey) {
            throw new Error('AccessDenied on DeleteObject blob')
          }
          return {}
        }
        throw new Error(`Unexpected command ${name}`)
      }
    } as unknown as S3Client

    const store = new S3ArtifactStore(
      {
        bucket: parseBucketName('b'),
        keyPrefix: '',
        region: 'us-east-1',
        forcePathStyle: true
      },
      {client: fakeClient}
    )

    await store.deleteArtifact(scope, parseArtifactName('to-delete'))
    expect(deletedKeys).toEqual([manifestKey, blobKey])
  })

  it('signs GetObject URLs in S3ArtifactStore.presignGetObject and rejects in InMemoryArtifactStore', async () => {
    const s3Store = new S3ArtifactStore({
      bucket: parseBucketName('presign-b'),
      keyPrefix: '',
      region: 'us-east-1',
      endpoint: 'https://s3.example.test',
      forcePathStyle: true,
      credentials: {
        accessKeyId: 'AKIA_PRESIGN',
        secretAccessKey: 'SECRET_PRESIGN'
      }
    })
    const url = await s3Store.presignGetObject('owner/repo/runs/101/blobs/99', 120)
    const parsed = new URL(url)
    expect(parsed.origin).toBe('https://s3.example.test')
    expect(parsed.pathname).toBe('/presign-b/owner/repo/runs/101/blobs/99')
    expect(parsed.searchParams.get('X-Amz-Expires')).toBe('120')
    expect(parsed.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/)

    const memStore = new InMemoryArtifactStore(parseBucketName('presign-b'))
    await expect(
      memStore.presignGetObject('owner/repo/runs/101/blobs/99', 120)
    ).rejects.toThrow('Presigned artifact URLs require an S3 client')
  })
})
