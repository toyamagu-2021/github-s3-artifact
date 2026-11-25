import {build} from 'esbuild'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const ROOT_DIR = path.resolve(import.meta.dirname, '..')
const DIST_DIR = path.join(ROOT_DIR, 'dist')

async function bundleEntry(entryPoint, outfile) {
  await fs.mkdir(path.dirname(outfile), {recursive: true})
  await build({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    sourcemap: false,
    minify: false,
    logLevel: 'info'
  })
}

await fs.mkdir(DIST_DIR, {recursive: true})
await fs.writeFile(
  path.join(DIST_DIR, 'package.json'),
  JSON.stringify({type: 'commonjs'}, null, 2) + '\n',
  'utf8'
)

await bundleEntry(
  path.join(ROOT_DIR, 'src/upload/index.ts'),
  path.join(DIST_DIR, 'upload/index.js')
)
await bundleEntry(
  path.join(ROOT_DIR, 'src/download/index.ts'),
  path.join(DIST_DIR, 'download/index.js')
)
