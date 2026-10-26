// @vitest-environment jsdom
/** Root-relative dsh paths resolve under the page's `<base href>`, never at the host's bare root. */

import { afterEach, describe, expect, it } from 'vitest'
import { dshUrl, pageBase } from '../src/client/page-base.ts'

afterEach(() => {
  document.head.replaceChildren()
})

describe('dshUrl', () => {
  it('resolves under the mount the served index names in <base href>', () => {
    const base = document.createElement('base')
    base.href = 'https://cowork.example/site.example/'
    document.head.append(base)
    expect(pageBase()).toBe('https://cowork.example/site.example/')
    expect(dshUrl('/api/session.list').href).toBe('https://cowork.example/site.example/api/session.list')
    expect(dshUrl('/plugins/??a/client.js,b/client.js&rev=1').href)
      .toBe('https://cowork.example/site.example/plugins/??a/client.js,b/client.js&rev=1')
    expect(dshUrl('/api/remote.mux').href).toBe('https://cowork.example/site.example/api/remote.mux')
  })

  it('tolerates a <base> without its trailing slash', () => {
    const base = document.createElement('base')
    base.href = 'https://cowork.example/site.example'
    document.head.append(base)
    expect(dshUrl('/api/x').href).toBe('https://cowork.example/site.example/api/x')
  })

  it('falls back to the origin when the page carries no <base>: the root, as before', () => {
    expect(pageBase()).toBe(`${location.origin}/`)
    expect(dshUrl('/api/x').href).toBe(`${location.origin}/api/x`)
  })
})
