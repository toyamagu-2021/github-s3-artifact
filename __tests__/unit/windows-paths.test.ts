import {describe, expect, it} from 'vitest'
import * as path from 'node:path'
import {getMultiPathLCA} from '../../src/core/search.js'
import {expandDestinationPath} from '../../src/download/inputs.js'

describe('Windows path handling', () => {
  it('keeps a drive-root separator in the multi-path LCA', () => {
    expect(
      getMultiPathLCA(
        ['C:\\work\\pkg-a\\dist', 'C:\\work\\pkg-b\\dist'],
        path.win32
      )
    ).toBe('C:\\work')

    expect(
      getMultiPathLCA(
        ['C:\\work\\pkg-a\\dist', 'C:\\other\\pkg-b\\dist'],
        path.win32
      )
    ).toBe('C:\\')

    expect(
      getMultiPathLCA(
        ['c:\\work\\pkg-a\\dist', 'C:\\work\\pkg-b\\dist'],
        path.win32
      )
    ).toBe('c:\\work')

    expect(
      getMultiPathLCA(
        ['\\\\server\\share\\pkg-a', '\\\\server\\share\\pkg-b'],
        path.win32
      )
    ).toBe('\\\\server\\share\\')

    expect(
      getMultiPathLCA(['/work/a', '/work/b'], path.win32)
    ).toBe('\\work')

    expect(
      getMultiPathLCA(['/work/pkg-a/dist', '/work/pkg-b/dist'], path.posix)
    ).toBe('/work')
  })

  it('expands a leading tilde with either slash and leaves ~prefix names untouched', () => {
    expect(
      expandDestinationPath('~\\out', {HOME: 'C:\\Users\\me'}, path.win32)
    ).toBe('C:\\Users\\me\\out')
    expect(
      expandDestinationPath(
        '~\\out',
        {USERPROFILE: 'C:\\Users\\runneradmin'},
        path.win32
      )
    ).toBe('C:\\Users\\runneradmin\\out')
    expect(
      expandDestinationPath('~/out', {HOME: '/home/me'}, path.posix)
    ).toBe('/home/me/out')
    expect(expandDestinationPath('~', {HOME: '/home/me'}, path.posix)).toBe(
      '/home/me'
    )
    expect(
      expandDestinationPath('~backup', {HOME: '/home/me'}, path.posix)
    ).toBe(path.posix.resolve('~backup'))
  })
})
