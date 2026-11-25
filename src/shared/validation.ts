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
  if (!name) {
    throw new ArtifactValidationError(
      'Provided artifact name input during validation is empty'
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
