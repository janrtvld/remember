import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import type { Page } from 'playwright-core'

export function useExistingQaCodexHome(directory: string, providerHome: string) {
  const file = join(directory, 'src/main/codexRuntime.ts')
  const source = readFileSync(file, 'utf8')
  const target = 'return { ...environment, CODEX_HOME: rememberCodexHome() }'
  assert.equal(source.split(target).length, 2, 'Only the owned QA provider-home boundary changes')
  writeFileSync(file, source.replace(target, `return { ...environment, CODEX_HOME: ${JSON.stringify(providerHome)} }`))
}

function speechState(profile: string, after: number) {
  const db = new DatabaseSync(join(profile, 'daily-review/evidence.sqlite'), { readOnly: true })
  try {
    const speech = db
      .prepare(
        'SELECT id, source, started_at, ended_at, text FROM speech_segment WHERE started_at >= ? AND rejection_reason IS NULL'
      )
      .all(after)
    const tasks = db
      .prepare(`SELECT DISTINCT a.work_item_id FROM ambient_task_source a
      JOIN speech_segment s ON s.id = a.source_id
      WHERE a.kind = 'speech' AND s.started_at >= ?`)
      .all(after)
    const outbox = db
      .prepare(`SELECT n.* FROM ambient_task_notification n
      WHERE n.work_item_id IN (SELECT a.work_item_id FROM ambient_task_source a
        JOIN speech_segment s ON s.id = a.source_id WHERE a.kind = 'speech' AND s.started_at >= ?)`)
      .all(after)
    return {
      speech: speech.map((row) => ({ ...row })),
      tasks: tasks.map((row) => ({ ...row })),
      outbox: outbox.map((row) => ({ ...row })),
    }
  } finally {
    db.close()
  }
}

export async function ambientLiveQa(options: {
  directory: string
  profile: string
  launch: () => Promise<Page>
  close: () => Promise<void>
  checks: string[]
}) {
  const { directory, profile, launch, close, checks } = options
  let page = await launch()
  await page.evaluate(() =>
    window.remember.updateSettings({
      offlineMode: false,
      cloudAnalysisConsent: true,
      liveTaskUpdates: true,
      audioCaptureEnabled: true,
      frequentDayRefresh: false,
      appCaptureMode: 'include',
      includedAppBundleIds: ['computer.remember.qa'],
      captureSchedule: { enabled: false, weekdays: [1, 2, 3, 4, 5], startTime: '09:00', endTime: '17:00' },
      capturePaused: false,
    })
  )
  await page.evaluate(() => window.remember.resumeCapture())
  const readyDeadline = Date.now() + 35_000
  while (true) {
    const state = await page.evaluate(() => window.remember.getState())
    if (state.status === 'recording' && state.agent.status === 'ready' && state.systemAudioCheckStatus === 'ready')
      break
    assert(
      Date.now() < readyDeadline,
      `Live capture and existing provider login must be ready: ${JSON.stringify({ status: state.status, agent: state.agent, system: state.systemAudioCheckStatus, error: state.error })}`
    )
    await delay(250)
  }
  const wav = join(directory, 'ambient-live-speech.aiff')
  const assignment =
    'Jan, wil jij nu de bevestiging over de paarse fiets naar de klant sturen? Dit moet vandaag nog gebeuren, anders missen we de afspraak.'
  const filler =
    'We bespreken ondertussen rustig het ontwerp van het product. De achtergrond is wit en de tekst staat duidelijk in beeld. Er zijn geen andere afspraken of acties.'
  const spoken = `${assignment} ${Array.from({ length: 10 }, () => filler).join(' ')}`
  const synthesized = spawnSync('/usr/bin/say', ['-v', 'Xander', '-r', '175', '-o', wav, spoken], { encoding: 'utf8' })
  assert.equal(synthesized.status, 0, synthesized.stderr)
  const startedAt = Date.now()
  const audio = spawn('/usr/bin/afplay', ['--volume', '0.4', wav], { stdio: 'ignore' })
  let firstTranscriptAt: number | null = null
  let taskAt: number | null = null
  let observed = speechState(profile, startedAt - 1000)
  try {
    const deadline = Date.now() + 150_000
    while (!taskAt) {
      observed = speechState(profile, startedAt - 1000)
      if (!firstTranscriptAt && observed.speech.some((row) => /bevestiging|paarse fiets/i.test(String(row.text))))
        firstTranscriptAt = Date.now()
      if (observed.tasks.length) taskAt = Date.now()
      if (!taskAt) {
        assert(Date.now() < deadline, 'Live speech must produce a source-linked task while capture is still running')
        await delay(250)
      }
    }
    assert.equal((await page.evaluate(() => window.remember.getState())).status, 'recording')
    assert.equal(observed.tasks.length, 1, 'The spoken assignment must create exactly one task')
    assert(observed.speech.some((row) => row.source === 'system' && /bevestiging|paarse fiets/i.test(String(row.text))))
    const taskId = String(observed.tasks[0].work_item_id)
    const task = (await page.evaluate(() => window.remember.listWorkItems())).find((item) => item.id === taskId)
    assert(task)
    await page.goto(`${new URL(page.url()).origin}/inbox/?item=${encodeURIComponent(taskId)}`)
    await page.getByText(task.title, { exact: true }).first().waitFor()
    await page.screenshot({ path: join(directory, 'ambient-live-task.png') })
    writeFileSync(
      join(directory, 'ambient-live-proof.json'),
      JSON.stringify(
        {
          assignment,
          task,
          observed,
          startedAt,
          firstTranscriptAt,
          taskAt,
          transcriptLatencyMs: firstTranscriptAt ? firstTranscriptAt - startedAt : null,
          taskLatencyMs: taskAt - startedAt,
          captureStillRunning: true,
          boundary:
            'Synthetic Dutch speech played over actual system output, real native audio capture and local Parakeet, live Codex inference using existing provider authentication in place, production policy/SQLite/renderer. This does not establish recognition of Jan’s own voice or natural-room accuracy.',
        },
        null,
        2
      )
    )
    await page.evaluate(() =>
      window.remember.updateSettings({ liveTaskUpdates: false, capturePaused: true, offlineMode: true })
    )
    await close()
    page = await launch()
    assert((await page.evaluate(() => window.remember.listWorkItems())).some((item) => item.id === taskId))
    checks.push(
      'Actual system speech reaches local ASR, live model analysis and one source-linked task before capture ends; task survives full restart'
    )
  } finally {
    audio.kill('SIGTERM')
    await page
      .evaluate(() =>
        window.remember.updateSettings({ liveTaskUpdates: false, capturePaused: true, offlineMode: true })
      )
      .catch(() => {})
  }
}
