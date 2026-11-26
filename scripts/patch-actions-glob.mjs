import * as fs from 'node:fs'

const target = 'node_modules/@actions/glob/lib/internal-pattern.js'
const source = fs.readFileSync(target, 'utf8')
const call =
  'return this.minimatch.matchOne(itemPath.split(IS_WINDOWS ? /\\\\+/ : /\\/+/), this.minimatch.set[0], true);'
const patched =
  "const partialPath = IS_WINDOWS ? itemPath.replace(/\\\\/g, '/') : itemPath;\n        return this.minimatch.match(partialPath, true);"

if (!source.includes('const partialPath = IS_WINDOWS')) {
  if (!source.includes(call)) {
    throw new Error(
      'patch-actions-glob: @actions/glob partialMatch no longer calls minimatch.matchOne; update the patch'
    )
  }
  fs.writeFileSync(target, source.replace(call, patched))
}
