import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import {
  createCachedSettingsStore,
  DEFAULT_SETTINGS,
  readSettingsAt,
  repairSettingsAt,
  writeSettingsAt,
} from '../settingsStore'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

async function temporarySettingsDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'remember-settings-'))
  temporaryDirectories.push(directory)
  return directory
}

describe('settingsStore', () => {
  it('starts with opt-in AI features and a 15-minute interval while preserving saved choices', async () => {
    const directory = await temporarySettingsDirectory()
    const initial = readSettingsAt(directory).settings
    assert.equal(initial.liveTaskUpdates, false)
    assert.equal(initial.agentLearningEnabled, false)
    assert.equal(initial.cloudAnalysisConsent, false)
    assert.equal(initial.frequentDayRefreshIntervalMinutes, 15)

    createCachedSettingsStore().update(
      directory,
      {
        liveTaskUpdates: true,
        agentLearningEnabled: true,
        cloudAnalysisConsent: true,
        frequentDayRefreshIntervalMinutes: 10,
      },
      Date.now()
    )
    const restarted = createCachedSettingsStore().get(directory)
    assert.equal(restarted.liveTaskUpdates, true)
    assert.equal(restarted.agentLearningEnabled, true)
    assert.equal(restarted.cloudAnalysisConsent, true)
    assert.equal(restarted.frequentDayRefreshIntervalMinutes, 10)
  })

  it('starts new profiles on GPT-6.1 Sol and Sonnet while preserving existing model choices', async () => {
    const directory = await temporarySettingsDirectory()
    const initial = readSettingsAt(directory).settings
    assert.equal(initial.codexAnalysisModel, 'gpt-6.1-sol')
    assert.equal(initial.claudeAnalysisModel, 'sonnet')
    writeSettingsAt(directory, { ...initial, codexAnalysisModel: 'gpt-5.6-terra', claudeAnalysisModel: 'opus' })
    const restarted = createCachedSettingsStore().get(directory)
    assert.equal(restarted.codexAnalysisModel, 'gpt-5.6-terra')
    assert.equal(restarted.claudeAnalysisModel, 'opus')
  })

  it('preserves an independent error-reporting choice across offline toggles, restart, and repairs', async () => {
    const directory = await temporarySettingsDirectory()
    const document: Record<string, unknown> = { ...DEFAULT_SETTINGS, settingsSchemaVersion: 1, settingsGeneration: 1 }
    delete document.errorReportingEnabled
    await writeFile(join(directory, 'settings.json'), JSON.stringify(document))
    assert.equal(readSettingsAt(directory).health.status, 'healthy')
    assert.equal(readSettingsAt(directory).settings.errorReportingEnabled, true)

    const store = createCachedSettingsStore()
    store.update(directory, { errorReportingEnabled: false }, Date.now())
    store.update(directory, { offlineMode: true }, Date.now())
    store.update(directory, { offlineMode: false }, Date.now())
    assert.equal(createCachedSettingsStore().get(directory).errorReportingEnabled, false)
    store.update(directory, { errorReportingEnabled: 'true' as unknown as boolean }, Date.now())
    assert.equal(createCachedSettingsStore().get(directory).errorReportingEnabled, false)

    await writeFile(join(directory, 'settings.json'), '{broken')
    assert.equal(readSettingsAt(directory).settings.errorReportingEnabled, false)
    assert.equal(repairSettingsAt(directory, 'restore-last-known-good').errorReportingEnabled, false)
    await writeFile(join(directory, 'settings.json'), '{broken')
    const repaired = repairSettingsAt(directory, 'use-safe-settings')
    assert.equal(repaired.offlineMode, true)
    assert.equal(repaired.errorReportingEnabled, false)
    assert.equal(createCachedSettingsStore().get(directory).errorReportingEnabled, false)
  })

  it('fails closed for an invalid stored error-reporting preference', async () => {
    const directory = await temporarySettingsDirectory()
    writeSettingsAt(directory, { ...DEFAULT_SETTINGS, errorReportingEnabled: false })
    const path = join(directory, 'settings.json')
    const document = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(path, JSON.stringify({ ...document, errorReportingEnabled: 'true' }))
    const snapshot = readSettingsAt(directory)
    assert.equal(snapshot.health.status, 'recovery-required')
    assert.equal(snapshot.settings.errorReportingEnabled, false)
    assert.equal(snapshot.settings.offlineMode, true)
  })

  it('defaults old profiles to this computer and persists only valid explicit remote endpoints', async () => {
    const directory = await temporarySettingsDirectory()
    const document: Record<string, unknown> = { ...DEFAULT_SETTINGS, settingsSchemaVersion: 1, settingsGeneration: 1 }
    delete document.agentComputer
    await writeFile(join(directory, 'settings.json'), JSON.stringify(document))
    assert.equal(readSettingsAt(directory).health.status, 'healthy')
    assert.deepEqual(readSettingsAt(directory).settings.agentComputer, { kind: 'local' })
    const remote = { kind: 'remote' as const, endpoint: 'ws://127.0.0.1:47123/', workspace: '/Users/ai/remember' }
    createCachedSettingsStore().update(directory, { agentComputer: remote }, Date.now())
    assert.deepEqual(createCachedSettingsStore().get(directory).agentComputer, remote)
    assert.throws(
      () =>
        createCachedSettingsStore().update(
          directory,
          { agentComputer: { ...remote, endpoint: 'ws://external.example:47123/' } },
          Date.now()
        ),
      /invalid-agent-computer-endpoint/
    )
    assert.deepEqual(createCachedSettingsStore().get(directory).agentComputer, remote)
    await writeFile(
      join(directory, 'settings.json'),
      JSON.stringify({ ...document, agentComputer: { ...remote, workspace: '../private' } })
    )
    assert.equal(readSettingsAt(directory).health.status, 'recovery-required')
    assert.deepEqual(readSettingsAt(directory).settings.agentComputer, { kind: 'local' })
  })

  it('preserves an optional display host after restart and rejects invalid updates without changing execution settings', async () => {
    const directory = await temporarySettingsDirectory()
    const computer = {
      kind: 'remote' as const,
      endpoint: 'ws://127.0.0.1:47832/',
      workspace: '/Users/ai/Agent',
      displayHost: 'Mac-Mini.local',
    }
    createCachedSettingsStore().update(directory, { agentComputer: computer }, Date.now())
    const expected = { ...computer, displayHost: 'mac-mini.local' }
    assert.deepEqual(createCachedSettingsStore().get(directory).agentComputer, expected)
    assert.throws(
      () =>
        createCachedSettingsStore().update(
          directory,
          { agentComputer: { ...computer, displayHost: 'ai@other' } },
          Date.now()
        ),
      /invalid-agent-computer-display-host/
    )
    assert.deepEqual(createCachedSettingsStore().get(directory).agentComputer, expected)
    createCachedSettingsStore().update(directory, { agentComputer: { ...computer, displayHost: '' } }, Date.now())
    const { displayHost: _host, ...withoutDisplay } = computer
    assert.deepEqual(createCachedSettingsStore().get(directory).agentComputer, withoutDisplay)
  })

  it('requires independent live task consent and keeps Day refresh changes separate across restart', async () => {
    const directory = await temporarySettingsDirectory()
    const document: Record<string, unknown> = {
      ...DEFAULT_SETTINGS,
      settingsSchemaVersion: 1,
      settingsGeneration: 1,
      frequentDayRefresh: true,
    }
    delete document.liveTaskUpdates
    await writeFile(join(directory, 'settings.json'), JSON.stringify(document))
    assert.equal(readSettingsAt(directory).health.status, 'healthy')
    assert.equal(readSettingsAt(directory).settings.liveTaskUpdates, false)
    createCachedSettingsStore().update(directory, { liveTaskUpdates: true }, Date.now())
    createCachedSettingsStore().update(directory, { frequentDayRefresh: false }, Date.now())
    assert.equal(createCachedSettingsStore().get(directory).liveTaskUpdates, true)
    createCachedSettingsStore().update(directory, { liveTaskUpdates: false }, Date.now())
    createCachedSettingsStore().update(directory, { frequentDayRefresh: true }, Date.now())
    assert.equal(createCachedSettingsStore().get(directory).liveTaskUpdates, false)
  })

  it('adds widget snoozing to existing profiles and persists its deadline independently of other settings', async () => {
    const directory = await temporarySettingsDirectory()
    const document: Record<string, unknown> = { ...DEFAULT_SETTINGS, settingsSchemaVersion: 1, settingsGeneration: 1 }
    delete document.edgeWidgetHiddenUntil
    await writeFile(join(directory, 'settings.json'), JSON.stringify(document))
    assert.equal(readSettingsAt(directory).health.status, 'healthy')
    assert.equal(readSettingsAt(directory).settings.edgeWidgetHiddenUntil, null)
    const deadline = Date.now() + 3_600_000
    createCachedSettingsStore().update(directory, { edgeWidgetHiddenUntil: deadline }, Date.now())
    createCachedSettingsStore().update(directory, { interfaceLanguage: 'nl' }, Date.now())
    assert.equal(createCachedSettingsStore().get(directory).edgeWidgetHiddenUntil, deadline)
    createCachedSettingsStore().update(directory, { edgeWidgetHiddenUntil: null }, Date.now())
    assert.equal(createCachedSettingsStore().get(directory).edgeWidgetHiddenUntil, null)
  })

  it('defaults existing widgets to the right and preserves the chosen docking edge across restarts', async () => {
    const directory = await temporarySettingsDirectory()
    const document: Record<string, unknown> = { ...DEFAULT_SETTINGS, settingsSchemaVersion: 1, settingsGeneration: 1 }
    delete document.edgeWidgetEdge
    await writeFile(join(directory, 'settings.json'), JSON.stringify(document))
    assert.equal(readSettingsAt(directory).settings.edgeWidgetEdge, 'right')
    assert.equal(readSettingsAt(directory).health.status, 'healthy')
    for (const edgeWidgetEdge of ['left', 'bottom', 'right'] as const) {
      createCachedSettingsStore().update(directory, { edgeWidgetEdge }, Date.now())
      assert.equal(createCachedSettingsStore().get(directory).edgeWidgetEdge, edgeWidgetEdge)
    }
  })

  it('adds dictation preferences to existing profiles and preserves explicit choices across restarts', async () => {
    const directory = await temporarySettingsDirectory()
    const document: Record<string, unknown> = { ...DEFAULT_SETTINGS, settingsSchemaVersion: 1, settingsGeneration: 1 }
    delete document.dictation
    await writeFile(join(directory, 'settings.json'), JSON.stringify(document))
    assert.deepEqual(readSettingsAt(directory).settings.dictation, DEFAULT_SETTINGS.dictation)
    assert.equal(readSettingsAt(directory).health.status, 'healthy')
    const dictation = {
      ...DEFAULT_SETTINGS.dictation,
      enabled: false,
      autoInsert: false,
      soundsEnabled: false,
      dimMediaDuringRecording: false,
      forceBuiltInMicWhenAudioPlaying: false,
      microphoneId: 'preferred-mic',
      shortcut: 'Alt+Space',
    }
    createCachedSettingsStore().update(directory, { dictation }, Date.now())
    assert.deepEqual(createCachedSettingsStore().get(directory).dictation, dictation)
    createCachedSettingsStore().update(directory, { edgeWidgetEnabled: false }, Date.now())
    assert.deepEqual(createCachedSettingsStore().get(directory).dictation, dictation)
  })
  it('enables the edge widget for existing settings and preserves an explicit opt-out', async () => {
    const directory = await temporarySettingsDirectory()
    const document: Record<string, unknown> = {
      ...DEFAULT_SETTINGS,
      settingsSchemaVersion: 1,
      settingsGeneration: 1,
    }
    delete document.edgeWidgetEnabled
    await writeFile(join(directory, 'settings.json'), JSON.stringify(document))
    const snapshot = readSettingsAt(directory)
    assert.equal(snapshot.health.status, 'healthy')
    assert.equal(snapshot.settings.edgeWidgetEnabled, true)
    const store = createCachedSettingsStore()
    store.update(directory, { edgeWidgetEnabled: false }, Date.now())
    assert.equal(createCachedSettingsStore().get(directory).edgeWidgetEnabled, false)
  })

  it('does not treat an earlier context import or completed setup as ongoing learning consent', async () => {
    const directory = await temporarySettingsDirectory()
    const document: Record<string, unknown> = {
      ...DEFAULT_SETTINGS,
      settingsSchemaVersion: 1,
      settingsGeneration: 1,
      contextImportOnboardingCompleted: true,
      contextImportCompletedAt: 1234,
    }
    for (const field of [
      'agentLearningEnabled',
      'agentLearningEnabledAt',
      'agentContextEnabled',
      'agentContextBindings',
    ])
      delete document[field]
    await writeFile(join(directory, 'settings.json'), JSON.stringify(document))
    const snapshot = readSettingsAt(directory)
    assert.equal(snapshot.health.status, 'healthy')
    assert.equal(snapshot.settings.agentLearningEnabled, false)
    assert.equal(snapshot.settings.agentLearningEnabledAt, null)
    assert.equal(Object.hasOwn(snapshot.settings, 'agentContextEnabled'), false)
    assert.deepEqual(snapshot.settings.agentContextBindings, [])
  })

  it('persists learning consent boundaries and renews the boundary on reenable', async () => {
    const directory = await temporarySettingsDirectory()
    const store = createCachedSettingsStore()
    store.update(directory, { agentLearningEnabled: true }, 1000)
    let saved = createCachedSettingsStore().get(directory)
    assert.equal(saved.agentLearningEnabledAt, 1000)
    store.update(directory, { agentLearningEnabled: false }, 2000)
    store.update(directory, { agentLearningEnabled: true }, 3000)
    saved = createCachedSettingsStore().get(directory)
    assert.equal(saved.agentLearningEnabledAt, 3000)
  })

  it('drops retired automatic delivery consent while preserving learning and project mappings', async () => {
    const directory = await temporarySettingsDirectory()
    const bindings = [{ directory: '/work/remember', spaceId: 'team', projectSlug: 'projects/remember' }]
    await writeFile(
      join(directory, 'settings.json'),
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        settingsSchemaVersion: 1,
        settingsGeneration: 1,
        agentContextEnabled: true,
        agentContextBindings: bindings,
        agentLearningEnabled: true,
        agentLearningEnabledAt: 1000,
      })
    )
    const store = createCachedSettingsStore()
    const saved = store.get(directory)
    assert.equal(Object.hasOwn(saved, 'agentContextEnabled'), false)
    assert.equal(saved.agentLearningEnabled, true)
    assert.equal(saved.agentLearningEnabledAt, 1000)
    assert.deepEqual(saved.agentContextBindings, bindings)
    store.update(directory, { interfaceTheme: 'dark' }, 2000)
    const restarted = createCachedSettingsStore().get(directory)
    assert.equal(Object.hasOwn(restarted, 'agentContextEnabled'), false)
    assert.deepEqual(restarted.agentContextBindings, bindings)
    assert.equal(JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')).agentContextEnabled, undefined)
  })

  it('keeps completed installs out of privacy onboarding and leaves unfinished installs unapproved', async () => {
    for (const completed of [false, true]) {
      const directory = await temporarySettingsDirectory()
      const document: Record<string, unknown> = {
        ...DEFAULT_SETTINGS,
        settingsSchemaVersion: 1,
        settingsGeneration: 1,
        audioCaptureOnboardingCompleted: completed,
        dayAnalysisOnboardingCompleted: completed,
        contextImportOnboardingCompleted: completed,
      }
      delete document.privacyOnboardingCompleted
      await writeFile(join(directory, 'settings.json'), JSON.stringify(document))
      const snapshot = readSettingsAt(directory)
      assert.equal(snapshot.health.status, 'healthy')
      assert.equal(snapshot.settings.privacyOnboardingCompleted, completed)
    }
  })

  it('persists privacy review and filters across a fresh settings store', async () => {
    const directory = await temporarySettingsDirectory()
    const store = createCachedSettingsStore()
    store.update(
      directory,
      {
        appCaptureMode: 'include',
        includedAppBundleIds: ['com.microsoft.VSCode'],
        excludedWebsites: ['private.example'],
        privacyOnboardingCompleted: true,
      },
      Date.now()
    )
    const settings = createCachedSettingsStore().get(directory)
    assert.equal(settings.privacyOnboardingCompleted, true)
    assert.equal(settings.appCaptureMode, 'include')
    assert.deepEqual(settings.includedAppBundleIds, ['com.microsoft.VSCode'])
    assert.deepEqual(settings.excludedWebsites, ['private.example'])
  })

  it('turns retired local day analysis off without treating current settings as damaged', async () => {
    const directory = await temporarySettingsDirectory()
    await writeFile(
      join(directory, 'settings.json'),
      JSON.stringify({
        settingsSchemaVersion: 1,
        settingsGeneration: 1,
        ...DEFAULT_SETTINGS,
        conversationProcessing: 'local',
        localAnalysisModel: 'balanced',
        dayAnalysisProvider: 'local',
        cloudAnalysisConsent: false,
        cloudConsentNoticeSeen: false,
      })
    )

    const snapshot = readSettingsAt(directory)

    assert.equal(snapshot.health.status, 'healthy')
    assert.equal(snapshot.settings.dayAnalysisProvider, null)
    assert.equal(snapshot.settings.cloudAnalysisConsent, false)
    assert.equal(snapshot.settings.cloudConsentNoticeSeen, false)
    assert.equal(Object.hasOwn(snapshot.settings, 'conversationProcessing'), false)
    assert.equal(Object.hasOwn(snapshot.settings, 'localAnalysisModel'), false)
  })

  it('distinguishes a fresh install from damaged settings', async () => {
    const directory = await temporarySettingsDirectory()

    const snapshot = readSettingsAt(directory)

    assert.equal(snapshot.health.status, 'missing')
    assert.deepEqual(snapshot.settings, DEFAULT_SETTINGS)
  })

  it('writes a versioned owner-only generation and last-known-good copy', async () => {
    const directory = await temporarySettingsDirectory()
    const settings = { ...DEFAULT_SETTINGS, capturePaused: true, offlineMode: true }

    writeSettingsAt(directory, settings)

    const document = JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'))
    assert.equal(document.settingsSchemaVersion, 1)
    assert.equal(document.settingsGeneration, 1)
    assert.equal(document.capturePaused, true)
    assert.equal((await stat(join(directory, 'settings.json'))).mode & 0o777, 0o600)
    assert.equal(existsSync(join(directory, 'settings.last-known-good.json')), true)
    assert.equal(readSettingsAt(directory).health.status, 'healthy')
  })

  it('migrates the legacy airgap key without ever defaulting a missing network policy on', async () => {
    const legacyDirectory = await temporarySettingsDirectory()
    const legacyDocument = {
      settingsSchemaVersion: 1,
      settingsGeneration: 1,
      ...DEFAULT_SETTINGS,
      airgapMode: true,
    } as Record<string, unknown>
    delete legacyDocument.offlineMode
    await writeFile(join(legacyDirectory, 'settings.json'), JSON.stringify(legacyDocument))

    const migrated = readSettingsAt(legacyDirectory)

    assert.equal(migrated.health.status, 'healthy')
    assert.equal(migrated.settings.offlineMode, true)

    const missingPolicyDirectory = await temporarySettingsDirectory()
    const missingPolicyDocument = { ...legacyDocument }
    delete missingPolicyDocument.airgapMode
    await writeFile(join(missingPolicyDirectory, 'settings.json'), JSON.stringify(missingPolicyDocument))

    const missingPolicy = readSettingsAt(missingPolicyDirectory)

    assert.equal(missingPolicy.health.status, 'recovery-required')
    assert.equal(missingPolicy.settings.offlineMode, true)
  })

  it('defaults automatic Revinote processing off in an existing versioned settings file', async () => {
    const directory = await temporarySettingsDirectory()
    writeSettingsAt(directory, DEFAULT_SETTINGS)
    const path = join(directory, 'settings.json')
    const document = JSON.parse(await readFile(path, 'utf8'))
    delete document.automaticRevinoteProcessing
    await writeFile(path, JSON.stringify(document))

    const snapshot = readSettingsAt(directory)

    assert.equal(snapshot.health.status, 'healthy')
    assert.equal(snapshot.settings.automaticRevinoteProcessing, false)
  })

  it('fails closed when the current generation is truncated', async () => {
    const directory = await temporarySettingsDirectory()
    writeSettingsAt(directory, { ...DEFAULT_SETTINGS, cloudAnalysisConsent: true, dayAnalysisProvider: 'codex' })
    await writeFile(join(directory, 'settings.json'), '{"cloudAnalysisConsent": true')

    const snapshot = readSettingsAt(directory)

    assert.equal(snapshot.health.status, 'recovery-required')
    assert.equal(snapshot.health.lastKnownGoodAvailable, true)
    assert.equal(snapshot.settings.capturePaused, true)
    assert.equal(snapshot.settings.audioCaptureEnabled, false)
    assert.equal(snapshot.settings.offlineMode, true)
    assert.equal(snapshot.settings.cloudAnalysisConsent, false)
    assert.equal(snapshot.settings.dayAnalysisProvider, null)
    assert.equal(snapshot.settings.launchAtLogin, false)
    assert.equal(snapshot.settings.appCaptureMode, 'include')
    assert.deepEqual(snapshot.settings.includedAppBundleIds, [])
  })

  it('rejects empty, partial-consent, and wrong-typed legacy documents', async () => {
    const validLookingPrefix = { ...DEFAULT_SETTINGS } as Partial<typeof DEFAULT_SETTINGS>
    delete validLookingPrefix.includedWebsites
    for (const [name, document] of [
      ['empty', {}],
      [
        'partial-consent',
        {
          dayAnalysisProvider: 'codex',
          dayAnalysisOnboardingCompleted: true,
          cloudAnalysisConsent: true,
          cloudConsentNoticeSeen: true,
        },
      ],
      ['valid-looking-prefix', validLookingPrefix],
      [
        'wrong-type',
        {
          ...DEFAULT_SETTINGS,
          audioCaptureEnabled: 'false',
        },
      ],
    ] as const) {
      const directory = await temporarySettingsDirectory()
      await writeFile(join(directory, 'settings.json'), JSON.stringify(document))

      const snapshot = readSettingsAt(directory)

      assert.equal(snapshot.health.status, 'recovery-required', name)
      assert.equal(snapshot.settings.capturePaused, true, name)
      assert.equal(snapshot.settings.cloudAnalysisConsent, false, name)
    }
  })

  it('does not overwrite recovery evidence through an ordinary update', async () => {
    const directory = await temporarySettingsDirectory()
    writeSettingsAt(directory, DEFAULT_SETTINGS)
    await writeFile(join(directory, 'settings.json'), '{}')

    assert.throws(() => writeSettingsAt(directory, { ...DEFAULT_SETTINGS, interfaceTheme: 'dark' }), {
      message: 'settings-recovery-required',
    })
    assert.equal(await readFile(join(directory, 'settings.json'), 'utf8'), '{}')
  })

  it('restores the last-known-good generation and quarantines the corrupt file', async () => {
    const directory = await temporarySettingsDirectory()
    const previous = {
      ...DEFAULT_SETTINGS,
      offlineMode: true,
      audioCaptureEnabled: false,
      capturePaused: true,
    }
    writeSettingsAt(directory, previous)
    await writeFile(join(directory, 'settings.json'), '{')

    const restored = repairSettingsAt(directory, 'restore-last-known-good')

    assert.deepEqual(restored, previous)
    assert.deepEqual(readSettingsAt(directory).settings, previous)
    assert.equal(readSettingsAt(directory).health.status, 'healthy')
    assert.equal(
      (await readdir(directory)).some((name) => name.startsWith('settings.invalid-')),
      true
    )
  })

  it('creates an explicit safe generation when no backup can be recovered', async () => {
    const directory = await temporarySettingsDirectory()
    await writeFile(join(directory, 'settings.json'), 'null')

    const repaired = repairSettingsAt(directory, 'use-safe-settings')

    assert.equal(repaired.capturePaused, true)
    assert.equal(repaired.audioCaptureEnabled, false)
    assert.equal(repaired.frequentDayRefresh, false)
    assert.equal(repaired.cloudAnalysisConsent, false)
    assert.equal(readSettingsAt(directory).health.status, 'healthy')
  })

  it('keeps ordinary reads in memory until an explicit refresh detects corruption', async () => {
    const directory = await temporarySettingsDirectory()
    const settings = { ...DEFAULT_SETTINGS, interfaceTheme: 'dark' as const }
    writeSettingsAt(directory, settings)
    const store = createCachedSettingsStore()

    assert.equal(store.get(directory).interfaceTheme, 'dark')
    await writeFile(join(directory, 'settings.json'), '{')
    assert.equal(store.get(directory).interfaceTheme, 'dark')

    const refreshed = store.refresh(directory)
    assert.equal(refreshed.health.status, 'recovery-required')
    assert.equal(store.get(directory).capturePaused, true)
    assert.equal(store.get(directory).interfaceTheme, 'dark')
  })

  it('reloads its snapshot when the user-data directory changes', async () => {
    const firstDirectory = await temporarySettingsDirectory()
    const secondDirectory = await temporarySettingsDirectory()
    writeSettingsAt(firstDirectory, { ...DEFAULT_SETTINGS, interfaceTheme: 'dark' })
    writeSettingsAt(secondDirectory, { ...DEFAULT_SETTINGS, interfaceTheme: 'light' })
    const store = createCachedSettingsStore()

    assert.equal(store.get(firstDirectory).interfaceTheme, 'dark')
    assert.equal(store.get(secondDirectory).interfaceTheme, 'light')
    assert.equal(store.get(firstDirectory).interfaceTheme, 'dark')
  })

  it('updates and repairs the cached snapshot only after durable store operations', async () => {
    const directory = await temporarySettingsDirectory()
    writeSettingsAt(directory, DEFAULT_SETTINGS)
    const store = createCachedSettingsStore()

    const updated = store.update(directory, { interfaceTheme: 'dark' }, 123)
    assert.equal(updated.interfaceTheme, 'dark')
    assert.equal(store.get(directory).interfaceTheme, 'dark')
    assert.equal(readSettingsAt(directory).settings.interfaceTheme, 'dark')

    await writeFile(join(directory, 'settings.json'), '{}')
    assert.throws(() => store.update(directory, { interfaceTheme: 'light' }, 456), {
      message: 'settings-recovery-required',
    })
    assert.equal(store.get(directory).capturePaused, true)

    const repaired = store.repair(directory, 'restore-last-known-good')
    assert.equal(repaired.interfaceTheme, 'system')
    assert.equal(store.get(directory).interfaceTheme, 'system')
    assert.equal(readSettingsAt(directory).health.status, 'healthy')
  })
})
