import {describe, expect, it} from 'vitest'
import {createHash} from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {Readable} from 'node:stream'
import {findFilesToUpload, buildZipSpecificationAsync} from '../../src/core/search.js'
import {createZipArchiveStream} from '../../src/core/archive-zip.js'
import {
  extractArchiveStream,
  verifyDigestAndMaterialize
} from '../../src/core/extract-zip.js'
import {ArtifactValidationError, ZipSlipError} from '../../src/shared/errors.js'
import {parseSha256Digest} from '../../src/shared/types.js'

async function collectStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

function createMaliciousZipBuffer(entryName: string, content: string): Buffer {
  const nameBuf = Buffer.from(entryName, 'utf8')
  const dataBuf = Buffer.from(content, 'utf8')

  const localHeader = Buffer.alloc(30)
  localHeader.writeUInt32LE(0x04034b50, 0)
  localHeader.writeUInt16LE(20, 4)
  localHeader.writeUInt16LE(0, 6)
  localHeader.writeUInt16LE(0, 8)
  localHeader.writeUInt16LE(0, 10)
  localHeader.writeUInt16LE(0, 12)
  const crc = crc32(dataBuf)
  localHeader.writeUInt32LE(crc >>> 0, 14)
  localHeader.writeUInt32LE(dataBuf.length, 18)
  localHeader.writeUInt32LE(dataBuf.length, 22)
  localHeader.writeUInt16LE(nameBuf.length, 26)
  localHeader.writeUInt16LE(0, 28)

  const cdOffset = localHeader.length + nameBuf.length + dataBuf.length
  const centralHeader = Buffer.alloc(46)
  centralHeader.writeUInt32LE(0x02014b50, 0)
  centralHeader.writeUInt16LE(20, 4)
  centralHeader.writeUInt16LE(20, 6)
  centralHeader.writeUInt16LE(0, 8)
  centralHeader.writeUInt16LE(0, 10)
  centralHeader.writeUInt16LE(0, 12)
  centralHeader.writeUInt16LE(0, 14)
  centralHeader.writeUInt32LE(crc >>> 0, 16)
  centralHeader.writeUInt32LE(dataBuf.length, 20)
  centralHeader.writeUInt32LE(dataBuf.length, 24)
  centralHeader.writeUInt16LE(nameBuf.length, 28)
  centralHeader.writeUInt16LE(0, 30)
  centralHeader.writeUInt16LE(0, 32)
  centralHeader.writeUInt16LE(0, 34)
  centralHeader.writeUInt16LE(0, 36)
  centralHeader.writeUInt32LE(0, 38)
  centralHeader.writeUInt32LE(0, 42)

  const cdSize = centralHeader.length + nameBuf.length
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(cdSize, 12)
  eocd.writeUInt32LE(cdOffset, 16)
  eocd.writeUInt16LE(0, 20)

  return Buffer.concat([localHeader, nameBuf, dataBuf, centralHeader, nameBuf, eocd])
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const byte of buf) {
    c ^= byte
    for (let i = 0; i < 8; i++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0)
    }
  }
  return (c ^ 0xffffffff) >>> 0
}

describe('Phase 2: search, zip creation, extraction, Zip-Slip, and digest verification', () => {
  it('computes single-file root stripping, multi-path LCA, excludes, hidden files, and symlinks (AC-01, AC-02, AC-03)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 's3-art-search-'))
    try {
      await fs.mkdir(path.join(tmp, 'a/b'), {recursive: true})
      await fs.writeFile(path.join(tmp, 'a/b/hello.txt'), 'hello')

      await fs.mkdir(path.join(tmp, 'pkg-a/dist'), {recursive: true})
      await fs.mkdir(path.join(tmp, 'pkg-b/dist'), {recursive: true})
      await fs.writeFile(path.join(tmp, 'pkg-a/dist/main.js'), 'a')
      await fs.writeFile(path.join(tmp, 'pkg-a/dist/sourcemap.map'), 'map')
      await fs.writeFile(path.join(tmp, 'pkg-b/dist/sub.js'), 'b')

      await fs.writeFile(path.join(tmp, '.env'), 'SECRET=1')
      await fs.mkdir(path.join(tmp, '.hidden'), {recursive: true})
      await fs.writeFile(path.join(tmp, '.hidden/file.txt'), 'hidden')
      await fs.writeFile(path.join(tmp, 'real.txt'), 'real-content')
      await fs.symlink(path.join(tmp, 'real.txt'), path.join(tmp, 'pkg-a/dist/link.txt'))
      await fs.symlink(path.join(tmp, 'missing-target.txt'), path.join(tmp, 'pkg-a/dist/broken.txt'))

      const single = await findFilesToUpload(path.join(tmp, 'a/b/hello.txt'), false)
      expect(single.filesToUpload).toEqual([path.join(tmp, 'a/b/hello.txt')])
      expect(single.rootDirectory).toBe(path.join(tmp, 'a/b'))
      const singleSpec = await buildZipSpecificationAsync(single.filesToUpload, single.rootDirectory)
      expect(singleSpec.map(s => s.archivePath)).toEqual(['hello.txt'])

      const multiPattern = [
        path.join(tmp, 'pkg-a/dist/**'),
        path.join(tmp, 'pkg-b/dist/**'),
        `!${path.join(tmp, '**/sourcemap.map')}`
      ].join('\n')
      const multi = await findFilesToUpload(multiPattern, false)
      expect(multi.rootDirectory).toBe(tmp)
      const multiSpec = await buildZipSpecificationAsync(multi.filesToUpload, multi.rootDirectory)
      const relPaths = multiSpec.map(s => s.archivePath).sort()
      expect(relPaths).toEqual([
        'pkg-a/dist/link.txt',
        'pkg-a/dist/main.js',
        'pkg-b/dist/sub.js'
      ])
      expect(multiSpec.find(s => s.archivePath === 'pkg-a/dist/link.txt')?.isSymbolicLink).toBe(true)

      const noHidden = await findFilesToUpload(path.join(tmp, '**/*'), false)
      expect(noHidden.filesToUpload.some(f => f.includes('.env'))).toBe(false)
      expect(noHidden.filesToUpload.some(f => f.includes('.hidden'))).toBe(false)

      const withHidden = await findFilesToUpload(path.join(tmp, '**/*'), true)
      expect(withHidden.filesToUpload.some(f => f.endsWith('.env'))).toBe(true)
      expect(
        withHidden.filesToUpload.some(f => f.endsWith(path.join('.hidden', 'file.txt')))
      ).toBe(true)

      const zipStream = await createZipArchiveStream(multiSpec, 6)
      const zipBuffer = await collectStream(zipStream)
      const digest = parseSha256Digest(
        `sha256:${createHash('sha256').update(zipBuffer).digest('hex')}`
      )

      const outDir = path.join(tmp, 'extracted')
      const res = await verifyDigestAndMaterialize({
        stream: Readable.from(zipBuffer),
        expectedDigest: digest,
        destinationDir: outDir,
        archived: true,
        rawFileName: 'multi.zip',
        skipDecompress: false
      })
      expect(res.digestMismatch).toBe(false)
      expect(await fs.readFile(path.join(outDir, 'pkg-a/dist/link.txt'), 'utf8')).toBe('real-content')
      expect(await fs.readFile(path.join(outDir, 'pkg-b/dist/sub.js'), 'utf8')).toBe('b')
      const linkStat = await fs.lstat(path.join(outDir, 'pkg-a/dist/link.txt'))
      expect(linkStat.isSymbolicLink()).toBe(false)
    } finally {
      await fs.rm(tmp, {recursive: true, force: true})
    }
  })

  it('rejects NTFS invalid characters inside archive relative paths (AC-16)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 's3-art-ntfs-'))
    try {
      const badFile = path.join(tmp, 'bad:name.txt')
      await fs.writeFile(badFile, 'x')
      await expect(buildZipSpecificationAsync([badFile], tmp)).rejects.toBeInstanceOf(
        ArtifactValidationError
      )
    } finally {
      await fs.rm(tmp, {recursive: true, force: true})
    }
  })

  it('prevents writing files before failing on digest mismatch when failOnDigestMismatch is true (AC-14)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 's3-art-digest-'))
    try {
      const zipBuf = createMaliciousZipBuffer('safe.txt', 'payload')
      const outDir = path.join(tmp, 'out')
      await fs.mkdir(outDir, {recursive: true})

      const result = await verifyDigestAndMaterialize({
        stream: Readable.from(zipBuf),
        expectedDigest: parseSha256Digest(`sha256:${'0'.repeat(64)}`),
        destinationDir: outDir,
        archived: true,
        rawFileName: 'test.zip',
        skipDecompress: false,
        abortOnDigestMismatch: true
      })

      expect(result.digestMismatch).toBe(true)
      await expect(fs.access(path.join(outDir, 'safe.txt'))).rejects.toThrow()
    } finally {
      await fs.rm(tmp, {recursive: true, force: true})
    }
  })

  it('blocks Zip-Slip traversal and absolute entry paths without writing outside destination (AC-15)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 's3-art-zipslip-'))
    try {
      const destDir = path.join(tmp, 'dest')
      await fs.mkdir(destDir, {recursive: true})

      for (const badEntry of ['../../evil.txt', '/etc/passwd', 'C:\\evil.txt', '../sibling/x.txt']) {
        const evilZip = createMaliciousZipBuffer(badEntry, 'pwned')
        await expect(extractArchiveStream(evilZip, destDir)).rejects.toBeInstanceOf(
          ZipSlipError
        )
      }

      await expect(fs.access(path.join(tmp, 'evil.txt'))).rejects.toThrow()
      await expect(fs.access(path.join(tmp, 'sibling/x.txt'))).rejects.toThrow()
    } finally {
      await fs.rm(tmp, {recursive: true, force: true})
    }
  })

  it('writes zip verbatim when skip-decompress is true (AC-13)', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 's3-art-skip-'))
    try {
      const zipBuf = createMaliciousZipBuffer('hello.txt', 'world')
      const digest = parseSha256Digest(
        `sha256:${createHash('sha256').update(zipBuf).digest('hex')}`
      )
      const destDir = path.join(tmp, 'out')
      const res = await verifyDigestAndMaterialize({
        stream: Readable.from(zipBuf),
        expectedDigest: digest,
        destinationDir: destDir,
        archived: true,
        rawFileName: 'bundle.zip',
        skipDecompress: true
      })
      expect(res.digestMismatch).toBe(false)
      const written = await fs.readFile(path.join(destDir, 'bundle.zip'))
      expect(written.equals(zipBuf)).toBe(true)
    } finally {
      await fs.rm(tmp, {recursive: true, force: true})
    }
  })
})
