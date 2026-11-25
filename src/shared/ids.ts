import {randomInt} from 'node:crypto'
import {type ArtifactId, parseArtifactId} from './types.js'

const TIMESTAMP_MULTIPLIER = 1024
const RANDOM_MAX = 1024
let lastGeneratedId = 0

export function generateArtifactId(nowMs: number = Date.now()): ArtifactId {
  const candidate =
    Math.trunc(nowMs) * TIMESTAMP_MULTIPLIER + randomInt(0, RANDOM_MAX)
  const unique = candidate <= lastGeneratedId ? lastGeneratedId + 1 : candidate
  lastGeneratedId = unique
  return parseArtifactId(String(unique))
}
