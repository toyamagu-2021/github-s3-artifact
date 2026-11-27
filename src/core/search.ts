import * as core from '@actions/core'
import * as glob from '@actions/glob'
import type {Stats} from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {ArtifactValidationError} from '../shared/errors.js'
import {validateRelativeArchivePath} from '../shared/validation.js'

export interface SearchResult {
  readonly filesToUpload: string[]
  readonly rootDirectory: string
}

export interface ZipFileEntrySpec {
  readonly sourcePath: string
  readonly archivePath: string
  readonly isSymbolicLink: boolean
}

export function getMultiPathLCA(
  searchPaths: readonly string[],
  pathApi: path.PlatformPath = path
): string {
  if (searchPaths.length === 0) {
    return pathApi.join()
  }

  const parsedPaths = searchPaths.map(p => {
    const normalized = pathApi.normalize(p)
    const {root} = pathApi.parse(normalized)
    const remainder = normalized.slice(root.length)
    const segments = remainder
      ? remainder.split(pathApi.sep).filter(Boolean)
      : []
    return {root, segments}
  })

  const firstRoot = parsedPaths[0]!.root
  const isWin32 = pathApi.sep === '\\'
  const sameRoot = parsedPaths.every(entry =>
    isWin32
      ? entry.root.toLowerCase() === firstRoot.toLowerCase()
      : entry.root === firstRoot
  )
  if (!sameRoot) {
    return pathApi.join()
  }

  const smallestLength = Math.min(...parsedPaths.map(p => p.segments.length))
  const commonParts: string[] = []
  for (let i = 0; i < smallestLength; i++) {
    const segment = parsedPaths[0]!.segments[i]
    if (segment === undefined) {
      break
    }
    if (!parsedPaths.every(p => p.segments[i] === segment)) {
      break
    }
    commonParts.push(segment)
  }

  if (commonParts.length === 0) {
    return firstRoot || pathApi.join()
  }
  return firstRoot
    ? pathApi.join(firstRoot, ...commonParts)
    : pathApi.join(...commonParts)
}

export async function findFilesToUpload(
  searchPath: string,
  includeHiddenFiles = false
): Promise<SearchResult> {
  const globber = await glob.create(searchPath, {
    followSymbolicLinks: true,
    implicitDescendants: true,
    omitBrokenSymbolicLinks: true,
    excludeHiddenFiles: !includeHiddenFiles
  })
  const rawResults = await globber.glob()

  const filesToUpload: string[] = []
  const seenLowerCase = new Set<string>()

  for (const candidate of rawResults) {
    let stats: Stats
    try {
      stats = await fs.stat(candidate)
    } catch {
      continue
    }
    if (stats.isDirectory()) {
      continue
    }
    filesToUpload.push(candidate)
    const lower = candidate.toLowerCase()
    if (seenLowerCase.has(lower)) {
      core.info(
        `Uploads are case insensitive: ${candidate} may overwrite another file with the same path`
      )
    } else {
      seenLowerCase.add(lower)
    }
  }

  const searchPaths = globber.getSearchPaths()
  if (searchPaths.length > 1) {
    return {
      filesToUpload,
      rootDirectory: getMultiPathLCA(searchPaths)
    }
  }

  const firstFile = filesToUpload[0]
  if (filesToUpload.length === 1 && firstFile && searchPaths[0] === firstFile) {
    return {
      filesToUpload,
      rootDirectory: path.dirname(firstFile)
    }
  }

  return {
    filesToUpload,
    rootDirectory: searchPaths[0] ?? process.cwd()
  }
}

export async function buildZipSpecificationAsync(
  filesToUpload: readonly string[],
  rootDirectory: string
): Promise<ZipFileEntrySpec[]> {
  const resolvedRoot = path.resolve(path.normalize(rootDirectory))
  const rootStats = await fs.stat(resolvedRoot).catch(() => null)
  if (!rootStats || !rootStats.isDirectory()) {
    throw new ArtifactValidationError(
      `Invalid artifact rootDirectory: '${resolvedRoot}' is not an existing directory.`
    )
  }

  const entries: ZipFileEntrySpec[] = []
  for (const file of filesToUpload) {
    const resolvedFile = path.resolve(path.normalize(file))
    const lstat = await fs.lstat(resolvedFile)
    if (lstat.isDirectory()) {
      continue
    }
    const rel = path.relative(resolvedRoot, resolvedFile)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new ArtifactValidationError(
        `File '${resolvedFile}' is outside rootDirectory '${resolvedRoot}'.`
      )
    }
    const posixRel = rel.split(path.sep).join('/')
    validateRelativeArchivePath(posixRel)
    entries.push({
      sourcePath: resolvedFile,
      archivePath: posixRel,
      isSymbolicLink: lstat.isSymbolicLink()
    })
  }
  return entries
}
