import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { isExcludedContext, normalizeWebsite } from '../exclusions'

const settings = {
  excludePasswordManagers: true,
  excludePrivateBrowsing: true,
  appCaptureMode: 'exclude' as const,
  excludedAppBundleIds: ['com.example.private'],
  includedAppBundleIds: [],
  websiteCaptureMode: 'exclude' as const,
  excludedWebsites: ['example.com'],
  includedWebsites: [],
}

describe('exclusions', () => {
  it('normalizes website input to a hostname', () => {
    assert.equal(normalizeWebsite('https://www.Example.com/private?q=1'), 'example.com')
    assert.equal(normalizeWebsite('not a domain'), null)
  })

  it('excludes password managers and selected apps', () => {
    assert.equal(
      isExcludedContext(
        { appName: '1Password', bundleId: 'com.1password.1password', windowTitle: '', text: '' },
        settings
      ),
      true
    )
    assert.equal(
      isExcludedContext({ appName: 'Private', bundleId: 'com.example.private', windowTitle: '', text: '' }, settings),
      true
    )
    assert.equal(
      isExcludedContext({ appName: 'Notes', bundleId: 'com.apple.Notes', windowTitle: '', text: '' }, settings),
      false
    )
    assert.equal(
      isExcludedContext(
        { appName: '1Password', bundleId: 'com.1password.1password', windowTitle: '', text: '' },
        { ...settings, excludePasswordManagers: false }
      ),
      false
    )
  })

  it('matches a website and its subdomains without matching unrelated hosts', () => {
    assert.equal(
      isExcludedContext(
        {
          appName: 'Safari',
          bundleId: 'com.apple.Safari',
          windowTitle: '',
          text: '',
          url: 'https://docs.example.com/a',
        },
        settings
      ),
      true
    )
    assert.equal(
      isExcludedContext(
        { appName: 'Safari', bundleId: 'com.apple.Safari', windowTitle: '', text: '', url: 'https://notexample.com' },
        settings
      ),
      false
    )
  })

  it('excludes browser private modes by default', () => {
    assert.equal(
      isExcludedContext(
        {
          appName: 'Google Chrome',
          bundleId: 'com.google.Chrome',
          windowTitle: 'New Incognito Tab',
          text: '',
          url: 'chrome://newtab',
        },
        settings
      ),
      true
    )
    assert.equal(
      isExcludedContext(
        {
          appName: 'Safari',
          bundleId: 'com.apple.Safari',
          windowTitle: 'Privénavigatie',
          text: '',
        },
        settings
      ),
      true
    )
    assert.equal(
      isExcludedContext(
        {
          appName: 'Google Chrome',
          bundleId: 'com.google.Chrome',
          windowTitle: 'New Incognito Tab',
          text: '',
        },
        { ...settings, excludePrivateBrowsing: false }
      ),
      false
    )
  })

  it('supports include-only capture for apps and browser domains', () => {
    const includeOnly = {
      ...settings,
      appCaptureMode: 'include' as const,
      includedAppBundleIds: ['com.apple.Safari'],
      websiteCaptureMode: 'include' as const,
      includedWebsites: ['openai.com'],
    }
    assert.equal(
      isExcludedContext({ appName: 'Notes', bundleId: 'com.apple.Notes', windowTitle: '', text: '' }, includeOnly),
      true
    )
    assert.equal(
      isExcludedContext(
        {
          appName: 'Safari',
          bundleId: 'com.apple.Safari',
          windowTitle: 'Docs',
          text: '',
          url: 'https://platform.openai.com/docs',
        },
        includeOnly
      ),
      false
    )
    assert.equal(
      isExcludedContext(
        {
          appName: 'Safari',
          bundleId: 'com.apple.Safari',
          windowTitle: 'News',
          text: '',
          url: 'https://example.com',
        },
        includeOnly
      ),
      true
    )
    assert.equal(
      isExcludedContext(
        {
          appName: 'Safari',
          bundleId: 'com.apple.Safari',
          windowTitle: 'URL unavailable',
          text: 'OpenAI documentation',
        },
        includeOnly
      ),
      true
    )
  })
})
