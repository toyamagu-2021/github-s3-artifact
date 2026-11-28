import {spawnSync} from 'node:child_process'
import {mkdtempSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'

export interface ReleasePull {
  number: number
  title: string
  body?: string
  mergedAt?: string
}

export interface ReleaseRef {
  tagName: string
  publishedAt: string
}

export function isReleasePull(pull: {title?: string}): boolean {
  return /^release for v\d/i.test((pull.title || '').trim())
}

function stripHtmlComments(body: string): string {
  const kept: string[] = []
  let skipping = false
  for (const line of body.split(/\r?\n/)) {
    if (skipping) {
      if (line.includes('-->')) skipping = false
      continue
    }
    const start = line.indexOf('<!--')
    if (start < 0) {
      kept.push(line)
      continue
    }
    const end = line.indexOf('-->', start + 4)
    if (end < 0) {
      skipping = true
      const before = line.slice(0, start).trim()
      if (before) kept.push(before)
      continue
    }
    const combined = `${line.slice(0, start)}${line.slice(end + 3)}`.trim()
    if (combined) kept.push(combined)
  }
  return kept.join('\n').trim()
}

function extractSection(body: string, heading: RegExp): string {
  const lines = body.split(/\r?\n/)
  const start = lines.findIndex(line => heading.test(line.trim()))
  if (start < 0) return ''
  const rest: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line.trim())) break
    rest.push(line)
  }
  return rest.join('\n').trim()
}

export function userFacingLines(pull: {title?: string; body?: string}): string[] {
  const body = stripHtmlComments(pull.body || '')
  const section =
    extractSection(body, /^##\s+what changed\b/i) ||
    extractSection(body, /^##\s+why\b/i) ||
    body
  const bullets = section
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => /^[-*]\s+/.test(line))
    .map(line => line.replace(/^[-*]\s+/, '').trim())
    .filter(Boolean)
    .slice(0, 5)
  if (bullets.length > 0) return bullets
  const paragraph = section
    .split(/\r?\n\s*\r?\n/)
    .map(part => part.replace(/\s+/g, ' ').trim())
    .find(part => part && !part.startsWith('#'))
  if (paragraph) return [paragraph]
  const title = (pull.title || '').trim()
  return title ? [title] : []
}

export function selectPulls(
  pulls: readonly ReleasePull[],
  range: {after?: string; until?: string} = {}
): ReleasePull[] {
  const afterMs = range.after ? Date.parse(range.after) : null
  const untilMs = range.until ? Date.parse(range.until) : null
  return pulls.filter(pull => {
    if (isReleasePull(pull)) return false
    const mergedMs = Date.parse(pull.mergedAt || '')
    if (Number.isNaN(mergedMs)) return false
    if (afterMs !== null && mergedMs <= afterMs) return false
    if (untilMs !== null && mergedMs > untilMs) return false
    return true
  })
}

export function buildReleaseNotes(input: {
  repository: string
  tag: string
  previousTag?: string
  pulls: readonly ReleasePull[]
}): string | null {
  if (input.pulls.length === 0) return null
  const lines = ['## Changes', '']
  for (const pull of input.pulls) {
    const url = `https://github.com/${input.repository}/pull/${pull.number}`
    lines.push(`### ${pull.title}`, '')
    for (const item of userFacingLines(pull)) {
      lines.push(`- ${item}`)
    }
    lines.push('', `[#${pull.number}](${url})`, '')
  }
  const compare = input.previousTag
    ? `https://github.com/${input.repository}/compare/${input.previousTag}...${input.tag}`
    : `https://github.com/${input.repository}/commits/${input.tag}`
  lines.push(`**Full changelog:** ${compare}`, '')
  return lines.join('\n')
}

function ghJson(args: readonly string[]): unknown {
  const result = spawnSync('gh', args, {encoding: 'utf8', env: process.env})
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim()
    throw new Error(detail || `gh exited ${String(result.status)}`)
  }
  return JSON.parse(result.stdout) as unknown
}

function asReleases(value: unknown): ReleaseRef[] {
  if (!Array.isArray(value)) throw new Error('gh release list did not return a list')
  return value.map(item => {
    if (!item || typeof item !== 'object') throw new Error('bad release row')
    const row = item as {tagName?: unknown; publishedAt?: unknown}
    if (typeof row.tagName !== 'string' || typeof row.publishedAt !== 'string') {
      throw new Error('bad release row')
    }
    return {tagName: row.tagName, publishedAt: row.publishedAt}
  })
}

function asPulls(value: unknown): ReleasePull[] {
  if (!Array.isArray(value)) throw new Error('gh pr list did not return a list')
  return value.map(item => {
    if (!item || typeof item !== 'object') throw new Error('bad pull row')
    const row = item as {
      number?: unknown
      title?: unknown
      body?: unknown
      mergedAt?: unknown
    }
    if (typeof row.number !== 'number' || typeof row.title !== 'string') {
      throw new Error('bad pull row')
    }
    return {
      number: row.number,
      title: row.title,
      ...(typeof row.body === 'string' ? {body: row.body} : {}),
      ...(typeof row.mergedAt === 'string' ? {mergedAt: row.mergedAt} : {})
    }
  })
}

function previousRelease(releases: readonly ReleaseRef[], tag: string): ReleaseRef | null {
  const ordered = [...releases].sort(
    (a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt)
  )
  const index = ordered.findIndex(release => release.tagName === tag)
  if (index < 0) throw new Error(`Release ${tag} is not in the latest release list`)
  return ordered[index + 1] ?? null
}

function main(): void {
  const tag = process.env.RELEASE_TAG || ''
  const repository = process.env.GITHUB_REPOSITORY || ''
  if (!/^v\d/.test(tag) || !repository) {
    throw new Error('RELEASE_TAG and GITHUB_REPOSITORY are required')
  }
  const releases = asReleases(
    ghJson([
      'release',
      'list',
      '-R',
      repository,
      '--limit',
      '30',
      '--json',
      'tagName,publishedAt'
    ])
  )
  const current = releases.find(release => release.tagName === tag)
  if (!current) throw new Error(`Release ${tag} is not published yet`)
  const previous = previousRelease(releases, tag)
  const pulls = asPulls(
    ghJson([
      'pr',
      'list',
      '-R',
      repository,
      '--state',
      'merged',
      '--limit',
      '100',
      '--json',
      'number,title,body,mergedAt'
    ])
  )
  const selected = selectPulls(pulls, {
    ...(previous ? {after: previous.publishedAt} : {}),
    until: current.publishedAt
  })
  const notes = buildReleaseNotes({
    repository,
    tag,
    ...(previous ? {previousTag: previous.tagName} : {}),
    pulls: selected
  })
  if (!notes) {
    process.stdout.write(
      'No pull requests to describe. Leaving the release body as tagpr wrote it.\n'
    )
    return
  }
  const dir = mkdtempSync(join(tmpdir(), 'release-notes-'))
  const notesFile = join(dir, 'notes.md')
  writeFileSync(notesFile, notes)
  const edit = spawnSync(
    'gh',
    ['release', 'edit', tag, '-R', repository, '--notes-file', notesFile],
    {encoding: 'utf8', env: process.env}
  )
  if (edit.status !== 0) {
    throw new Error((edit.stderr || edit.stdout || '').trim() || 'gh release edit failed')
  }
  process.stdout.write(notes)
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
