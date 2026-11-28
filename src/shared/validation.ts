import * as path from 'node:path'
import {ArtifactValidationError} from './errors.js'

// Characters disallowed on NTFS / cross-platform artifact uploads.
const INVALID_ARCHIVE_PATH_CHARS: ReadonlyArray<readonly [string, string]> = [
  ['"', 'Double quote "'],
  [':', 'Colon :'],
  ['<', 'Less than <'],
  ['>', 'Greater than >'],
  ['|', 'Vertical bar |'],
  ['*', 'Asterisk *'],
  ['?', 'Question mark ?'],
  ['\r', 'Carriage return \\r'],
  ['\n', 'Line feed \\n']
]

const INVALID_ARTIFACT_NAME_CHARS: ReadonlyArray<readonly [string, string]> = [
  ...INVALID_ARCHIVE_PATH_CHARS,
  ['\\', 'Backslash \\'],
  ['/', 'Forward slash /']
]

export function validateArtifactName(name: string): void {
  const trimmed = name.trim()
  if (!trimmed) {
    throw new ArtifactValidationError(
      'Provided artifact name input during validation is empty'
    )
  }

  if (trimmed === '.' || trimmed === '..') {
    throw new ArtifactValidationError(
      `Invalid artifact name '${name}': relative path segments '.' and '..' are not allowed.`
    )
  }

  for (const [char, label] of INVALID_ARTIFACT_NAME_CHARS) {
    if (name.includes(char)) {
      throw new ArtifactValidationError(
        `Invalid artifact name '${name}': contains forbidden character (${label}).`
      )
    }
  }
}

export function resolveSafeArtifactSubdir(
  baseDir: string,
  artifactName: string
): string {
  validateArtifactName(artifactName)
  const resolvedBase = path.resolve(baseDir)
  const targetDir = path.resolve(resolvedBase, artifactName)
  const rel = path.relative(resolvedBase, targetDir)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new ArtifactValidationError(
      `Invalid artifact name '${artifactName}': resolves outside destination directory.`
    )
  }
  return targetDir
}

export function validateRelativeArchivePath(relativePath: string): void {
  if (!relativePath) {
    throw new ArtifactValidationError(
      'Provided archive relative path during validation is empty'
    )
  }

  for (const [char, label] of INVALID_ARCHIVE_PATH_CHARS) {
    if (relativePath.includes(char)) {
      throw new ArtifactValidationError(
        `Invalid file path '${relativePath}': contains forbidden character (${label}).`
      )
    }
  }
}
