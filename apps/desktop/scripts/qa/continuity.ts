import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright-core'

export async function continuityQa(options: {
  desktopDirectory: string
  profile: string
  runDirectory: string
  launch: () => Promise<Page>
  closeElectron: () => Promise<void>
  checks: string[]
}) {
  const dataDirectory = join(options.profile, 'daily-review')
  const command = join(options.desktopDirectory, 'native', 'remember')
  const read = (...args: string[]) =>
    JSON.parse(
      execFileSync(command, [...args, '--json'], {
        env: {
          ...process.env,
          REMEMBER_DATA_DIR: dataDirectory,
          REMEMBER_CONTINUITY_DIR: join(options.runDirectory, 'continuity-cache'),
          REMEMBER_AGENT: 'codex',
        },
        encoding: 'utf8',
        timeout: 20_000,
      })
    )

  let target = await options.launch()
  const conversations = read('conversations', '--view', 'list', '--limit', '5')
  assert(conversations.items.some((entry: { id: string }) => entry.id === 'qa-episode'))
  const conversation = conversations.items.find((entry: { id: string }) => entry.id === 'qa-episode')
  const transcript = read(
    'conversations',
    conversation.date,
    '--view',
    'transcript',
    '--id',
    conversation.id,
    '--revision',
    conversation.revision
  )
  assert.equal(transcript.availability, 'available')
  assert(transcript.text.includes('Synthetic QA evidence'))
  const item = await target.evaluate(() =>
    window.remember.createWorkItem({ title: 'QA continuity correction', description: 'Synthetic local task' })
  )
  const before = read('now')
  writeFileSync(join(options.runDirectory, 'continuity-before.json'), JSON.stringify(before, null, 2), { mode: 0o600 })
  assert.equal(before.dataDirectory, dataDirectory)
  assert.equal(
    before.capture.availability,
    'live',
    `The native CLI socket must be reachable before testing restart: ${JSON.stringify(before.capture)}`
  )
  const initial = read('inbox', 'read', item.id)
  assert.equal(initial.lifecycle, 'open')
  const baseline = read('changes')
  assert.equal(baseline.baseline, true)

  await target.evaluate((id) => window.remember.setWorkItemLifecycle(id, 'completed'), item.id)
  await target.evaluate((id) => window.remember.setWorkItemLifecycle(id, 'open'), item.id)
  await target.evaluate(
    (id) =>
      window.remember.updateWorkItem(id, {
        title: 'QA corrected after completion',
        description: 'Synthetic local task with a later correction',
      }),
    item.id
  )
  const corrected = read('inbox', 'read', item.id)
  assert.equal(corrected.title, 'QA corrected after completion')
  assert.equal(corrected.lifecycle, 'open')
  assert(corrected.facts.some((fact: { type: string }) => fact.type === 'completed'))
  assert(corrected.facts.some((fact: { type: string }) => fact.type === 'reopened'))
  const changes = read('changes', '--since', baseline.checkpoint)
  assert.equal(changes.hasMore, false)
  assert(changes.changes.length > 0, 'Native Inbox changes must be visible to the CLI')

  await options.closeElectron()
  const offline = read('now')
  assert.equal(offline.capture.availability, 'unknown')
  target = await options.launch()
  const restored = read('inbox', 'read', item.id)
  const restartedTranscript = read(
    'conversations',
    conversation.date,
    '--view',
    'transcript',
    '--id',
    conversation.id,
    '--revision',
    conversation.revision
  )
  assert.equal(restartedTranscript.text, transcript.text)
  assert.deepEqual(restored, corrected, 'Inbox correction and lifecycle history must survive native restart')
  const after = read('now')
  const capture = await target.evaluate(() => window.remember.getState())
  assert.equal(after.capture.availability, 'live')
  assert.equal(after.capture.status, capture.status)
  await target.evaluate(() => window.close())
  const backgroundConversations = read('conversations', '--view', 'list', '--limit', '5')
  assert.deepEqual(backgroundConversations.items, conversations.items)

  writeFileSync(
    join(options.runDirectory, 'continuity-proof.json'),
    JSON.stringify(
      {
        conversations,
        backgroundConversations,
        transcript,
        restartedTranscript,
        before,
        initial,
        baseline,
        corrected,
        changes,
        offline,
        restored,
        after,
      },
      null,
      2
    ),
    { mode: 0o600 }
  )
  options.checks.push('Compiled CLI reads live capture status from the same native Remember profile')
  options.checks.push('Native Inbox completion, reopening and correction reach the incremental CLI feed')
  options.checks.push('Source state, lifecycle history and CLI access survive a full Electron restart')
  options.checks.push(
    'Bounded conversation listing and revision-checked transcript reads use the native archive across restart'
  )
  options.checks.push('Conversation reads work with the Remember window closed')
}
