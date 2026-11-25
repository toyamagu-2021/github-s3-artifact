export class ArtifactValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArtifactValidationError'
  }
}

export class ArtifactNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArtifactNotFoundError'
  }
}

export class ArtifactConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArtifactConflictError'
  }
}

export class DigestMismatchError extends Error {
  readonly artifacts: readonly string[]

  constructor(artifacts: readonly string[]) {
    super(
      `Digest validation failed for artifact(s): ${artifacts.join(', ')}. Use 'digest-mismatch: warn' to continue on mismatch.`
    )
    this.name = 'DigestMismatchError'
    this.artifacts = artifacts
  }
}

export class ZipSlipError extends Error {
  constructor(entryPath: string) {
    super(`Blocked unsafe archive entry path outside destination: ${entryPath}`)
    this.name = 'ZipSlipError'
  }
}
