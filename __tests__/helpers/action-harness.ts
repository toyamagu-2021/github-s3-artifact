import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

export interface ActionInvocationResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
  readonly outputs: Record<string, string>
  readonly warnings: string[]
  readonly maskedSecrets: string[]
}

export function parseGitHubOutputFile(content: string): Record<string, string> {
  const outputs: Record<string, string> = {}
  const lines = content.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (!line) {
      continue
    }
    const eqIndex = line.indexOf('=')
    const delimIndex = line.indexOf('<<')
    if (delimIndex > 0 && (eqIndex === -1 || delimIndex < eqIndex)) {
      const key = line.slice(0, delimIndex)
      const delimiter = line.slice(delimIndex + 2)
      const valueLines: string[] = []
      for (i = i + 1; i < lines.length; i++) {
        const inner = lines[i] ?? ''
        if (inner === delimiter) {
          break
        }
        valueLines.push(inner)
      }
      outputs[key] = valueLines.join('\n')
    } else if (eqIndex > 0) {
      outputs[line.slice(0, eqIndex)] = line.slice(eqIndex + 1)
    }
  }
  return outputs
}

export async function runActionBoundary(opts: {
  readonly run: () => Promise<void>
  readonly inputs: Record<string, string>
  readonly env?: Record<string, string>
  readonly cwd?: string
}): Promise<ActionInvocationResult> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 's3-art-harness-'))
  const outputFile = path.join(tmpDir, 'github_output.txt')
  await fs.writeFile(outputFile, '', 'utf8')

  const savedEnv = {...process.env}
  const savedCwd = process.cwd()
  const stdoutChunks: string[] = []
  const stderrChunks: string[] = []

  const origStdoutWrite = process.stdout.write.bind(process.stdout)
  const origStderrWrite = process.stderr.write.bind(process.stderr)

  process.stdout.write = (chunk: Uint8Array | string): boolean => {
    stdoutChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }

  process.stderr.write = (chunk: Uint8Array | string): boolean => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
    return true
  }

  let exitCode: number
  const savedExitCode = process.exitCode
  process.exitCode = 0

  try {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('INPUT_') || key.startsWith('S3_ARTIFACT_')) {
        delete process.env[key]
      }
    }

    process.env.GITHUB_OUTPUT = outputFile
    process.env.GITHUB_REPOSITORY = 'octo/repo'
    process.env.GITHUB_RUN_ID = '1001'
    process.env.GITHUB_RUN_ATTEMPT = '1'
    if (opts.env) {
      for (const [k, v] of Object.entries(opts.env)) {
        process.env[k] = v
      }
    }
    for (const [k, v] of Object.entries(opts.inputs)) {
      const inputKey = `INPUT_${k.replace(/ /g, '_').toUpperCase()}`
      process.env[inputKey] = v
    }

    if (opts.cwd) {
      process.chdir(opts.cwd)
    }

    await opts.run()
    exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0
  } catch (err) {
    stderrChunks.push(err instanceof Error ? err.message : String(err))
    exitCode = 1
  } finally {
    process.exitCode = savedExitCode
    process.chdir(savedCwd)
    process.stdout.write = origStdoutWrite
    process.stderr.write = origStderrWrite
    for (const k of Object.keys(process.env)) {
      if (!(k in savedEnv)) {
        delete process.env[k]
      }
    }
    Object.assign(process.env, savedEnv)
  }

  const rawOutput = await fs.readFile(outputFile, 'utf8')
  await fs.rm(tmpDir, {recursive: true, force: true})

  const stdout = stdoutChunks.join('')
  const stderr = stderrChunks.join('')
  const warnings = stdout
    .split(/\r?\n/)
    .filter(line => line.startsWith('::warning::'))
    .map(line => line.slice('::warning::'.length))
  const maskedSecrets = stdout
    .split(/\r?\n/)
    .filter(line => line.startsWith('::add-mask::'))
    .map(line => line.slice('::add-mask::'.length))

  return {
    exitCode,
    stdout,
    stderr,
    outputs: parseGitHubOutputFile(rawOutput),
    warnings,
    maskedSecrets
  }
}
