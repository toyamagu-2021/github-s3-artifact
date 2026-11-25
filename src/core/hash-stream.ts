import {createHash} from 'node:crypto'
import {Transform, type TransformCallback} from 'node:stream'
import {type Sha256Digest, parseSha256Digest} from '../shared/types.js'

export interface StreamHashResult {
  readonly size: number
  readonly digest: Sha256Digest
}

export class HashCountTransform extends Transform {
  private readonly hash = createHash('sha256')
  private byteCount = 0
  private finalized?: StreamHashResult

  override _transform(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: TransformCallback
  ): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)
    this.byteCount += buf.length
    this.hash.update(buf)
    callback(null, buf)
  }

  override _flush(callback: TransformCallback): void {
    this.result()
    callback()
  }

  result(): StreamHashResult {
    if (!this.finalized) {
      this.finalized = {
        size: this.byteCount,
        digest: parseSha256Digest(`sha256:${this.hash.digest('hex')}`)
      }
    }
    return this.finalized
  }
}

export function createHashStream(): HashCountTransform {
  return new HashCountTransform()
}
