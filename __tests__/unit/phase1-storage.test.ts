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
  it('validates artifact names against NTFS and path separators (AC-16)', () => {
    expect(() => validateArtifactName('')).toThrow()
    for (const bad of ['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'a\rb', 'a\nb']) {
      expect(() => validateArtifactName(bad)).toThrow()
    }
    expect(parseArtifactName('build-linux-x64')).toBe('build-linux-x64')
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
    const store = new InMemoryArtifactStore(parseBucketName('test-bucket'), '', () => now)

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
})
