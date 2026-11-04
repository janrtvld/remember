import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { DailyReviewContextMoment } from '@remember/shared'
import { detectCallSurface } from './callSurfaces'

function moment(overrides: Partial<DailyReviewContextMoment>): DailyReviewContextMoment {
  return {
    id: 'context',
    timestamp: 1_000,
    appName: 'Dia',
    bundleId: 'company.thebrowser.dia',
    windowTitle: '',
    text: '',
    textSource: 'accessibility',
    trigger: 'content-change',
    monitorName: '',
    screenshotPath: '',
    ...overrides,
  }
}

describe('call surface detection', () => {
  it('recognizes explicit Discord and Woub active calls', () => {
    assert.deepEqual(
      detectCallSurface(
        moment({
          appName: 'Discord',
          bundleId: 'com.hnc.Discord',
          windowTitle: 'Tom — Discord',
          text: 'Spraak gekoppeld\nVerbinding verbreken',
        })
      ),
      { provider: 'discord', surfaceKey: 'discord:call', state: 'active' }
    )
    assert.deepEqual(
      detectCallSurface(
        moment({
          windowTitle: 'Sprint review — Woub',
          url: 'https://app.woub.chat/call/42',
          text: 'Gespreksduur 00:12:31\nMicrofoon dempen',
        })
      ),
      { provider: 'woub', surfaceKey: 'woub:42', state: 'active' }
    )
  })

  it('keeps one Discord call identity while the user browses channels', () => {
    const woubChannel = detectCallSurface(
      moment({
        appName: 'Discord',
        bundleId: 'com.hnc.Discord',
        windowTitle: 'Woub — Discord',
        text: 'Spraak gekoppeld\nVerbinding verbreken',
      })
    )
    const chillenChannel = detectCallSurface(
      moment({
        appName: 'Discord',
        bundleId: 'com.hnc.Discord',
        windowTitle: 'Chillen — Discord',
        text: 'Spraak gekoppeld\nVerbinding verbreken',
      })
    )

    assert.deepEqual(woubChannel, chillenChannel)
    assert.equal(woubChannel?.surfaceKey, 'discord:call')
  })

  it('does not activate from a roster status alone', () => {
    assert.equal(
      detectCallSurface(moment({ windowTitle: 'Woub', url: 'https://app.woub.chat', text: 'Tom\nIN GESPREK' })),
      null
    )
  })

  it('ignores historical completed calls and message timestamps in a Woub chat', () => {
    assert.equal(
      detectCallSurface(
        moment({
          windowTitle: 'Woub',
          url: 'https://app.woub.chat/project/123/chats/456',
          text: '04 sep. om 01:59\nGesprek afgerond\nTom en 2 anderen waren 13 minuten in gesprek\n14:29',
        })
      ),
      null
    )
  })

  it('does not infer a local call from a timed participant roster', () => {
    assert.equal(
      detectCallSurface(moment({ appName: 'Discord', windowTitle: 'Discord', text: 'Tom\nIn call\n00:12:31' })),
      null
    )
  })

  it('recognizes an explicit return-to-join state as ended', () => {
    assert.deepEqual(
      detectCallSurface(
        moment({
          windowTitle: 'Weekly — Google Meet',
          url: 'https://meet.google.com/abc-defg-hij',
          text: 'Join meeting',
        })
      ),
      { provider: 'google-meet', surfaceKey: 'google-meet:abc-defg-hij', state: 'ended' }
    )
  })
})
