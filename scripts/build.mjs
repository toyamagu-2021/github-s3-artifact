import {build} from 'esbuild'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

const ROOT_DIR = path.resolve(import.meta.dirname, '..')
const DIST_DIR = path.join(ROOT_DIR, 'dist')

const stubUnusedOidcPlugin = {
  name: 'stub-unused-actions-core-oidc',
  setup(buildApi) {
    buildApi.onResolve({filter: /\/oidc-utils\.js$/}, args => {
      if (args.importer.includes('@actions/core')) {
        return {path: 'oidc-utils-stub', namespace: 's3-artifact-stub'}
      }
      return undefined
    })
    buildApi.onLoad({filter: /.*/, namespace: 's3-artifact-stub'}, () => ({
      contents:
        'export class OidcClient { static async getIDToken() { throw new Error("OIDC token API is not used by github-s3-artifact"); } }',
      loader: 'js'
    }))
  }
}

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
    logLevel: 'info',
    plugins: [stubUnusedOidcPlugin]
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
await bundleEntry(
  path.join(ROOT_DIR, 'src/merge/index.ts'),
  path.join(DIST_DIR, 'merge/index.js')
)
