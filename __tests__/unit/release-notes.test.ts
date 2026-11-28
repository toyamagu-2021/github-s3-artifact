import {describe, expect, it} from 'vitest'
import {
  buildReleaseNotes,
  isReleasePull,
  selectPulls,
  userFacingLines
} from '../../scripts/release-notes.js'

const repository = 'toyamagu-2021/github-s3-artifact'

describe('release notes', () => {
  it('drops the tagpr release pull request', () => {
    const release = {
      number: 22,
      title: 'Release for v0.1.3',
      body: '* [tagpr] prepare for the next release',
      mergedAt: '2026-11-28T06:05:00Z'
    }
    expect(isReleasePull(release)).toBe(true)
    expect(
      buildReleaseNotes({
        repository,
        tag: 'v0.1.3',
        previousTag: 'v0.1.2',
        pulls: selectPulls([release], {
          after: '2026-11-27T00:00:00Z',
          until: '2026-11-28T06:05:00Z'
        })
      })
    ).toBeNull()
  })

  it('turns the pull request body into user-facing lines', () => {
    const pull = {
      number: 21,
      title: 'fix(storage,download): filter expired manifests',
      body: [
        '## Why',
        'Listing was wrong once the cap filled up.',
        '',
        '## What changed',
        '- Filter expired manifests before the list cap.',
        '- Create download-path when a zero-match download has no directory.',
        '',
        '## Scope',
        '- src/storage/'
      ].join('\n'),
      mergedAt: '2026-11-28T05:54:48Z'
    }
    expect(userFacingLines(pull)).toEqual([
      'Filter expired manifests before the list cap.',
      'Create download-path when a zero-match download has no directory.'
    ])
    const notes = buildReleaseNotes({
      repository,
      tag: 'v0.1.3',
      previousTag: 'v0.1.2',
      pulls: [pull]
    })
    expect(notes).toContain('Filter expired manifests before the list cap.')
    expect(notes).toContain(
      'https://github.com/toyamagu-2021/github-s3-artifact/pull/21'
    )
    expect(notes).toContain(
      'https://github.com/toyamagu-2021/github-s3-artifact/compare/v0.1.2...v0.1.3'
    )
    expect(notes).not.toContain('src/storage/')
  })

  it('drops HTML comments without leaving the comment markers in the notes', () => {
    const pull = {
      number: 30,
      title: 'docs: explain merge',
      body: ['<!-- generated -->', '## What changed', '- Document the merge sub-action.'].join(
        '\n'
      ),
      mergedAt: '2026-11-28T05:00:00Z'
    }
    const notes = buildReleaseNotes({
      repository,
      tag: 'v0.1.4',
      previousTag: 'v0.1.3',
      pulls: [pull]
    })
    expect(notes).toContain('Document the merge sub-action.')
    expect(notes).not.toContain('<!--')
    expect(notes).not.toContain('generated')
  })

  it('does not build a body when the range has no pull requests', () => {
    const older = {
      number: 18,
      title: 'feat(upload): add an opt-in presigned artifact-url',
      body: '## What changed\n- Add a presigned URL output.',
      mergedAt: '2026-11-26T00:00:00Z'
    }
    const selected = selectPulls([older], {
      after: '2026-11-27T00:00:00Z',
      until: '2026-11-28T06:05:00Z'
    })
    expect(selected).toEqual([])
    expect(
      buildReleaseNotes({
        repository,
        tag: 'v0.1.3',
        previousTag: 'v0.1.2',
        pulls: selected
      })
    ).toBeNull()
  })
})
