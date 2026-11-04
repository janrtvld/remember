import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { WikiPageUpdate } from '@remember/shared'
import { dayWikiManagedBody, materializeDayWikiEdits } from '../dayWikiEdits'
import { generateOptionalDayWikiUpdates } from '../dayWikiUpdates'

const candidate: WikiPageUpdate = {
  slug: 'projects/trip',
  title: 'Trip',
  content: 'A lossy draft that omitted unrelated sections.',
  summary: 'Revise the route.',
  changeType: 'updated',
}

test('targeted corrections preserve a long page and all unrelated decisions verbatim', () => {
  const unrelated = `## Camera\n\n${'Keep the budget and existing source link.\n'.repeat(600)}`
  const current = `## Route\n\nLeave on Friday.\n\n${unrelated}\n## Lodging\n\nNot booked.`
  const result = materializeDayWikiEdits(candidate, current, {
    summary: 'Leave Saturday and retain the confirmed booking.',
    edits: [
      { oldText: 'Leave on Friday.', newText: 'Leave on Saturday.' },
      { oldText: 'Not booked.', newText: 'Booked with free cancellation.' },
    ],
  })
  assert.equal(
    result?.content,
    current.replace('Leave on Friday.', 'Leave on Saturday.').replace('Not booked.', 'Booked with free cancellation.')
  )
  assert.ok(result?.content?.includes(unrelated))
  assert.ok((result?.content?.length ?? 0) > 20_000)
})

test('all replacements target the original text, including when one replacement contains another anchor', () => {
  assert.equal(
    materializeDayWikiEdits(candidate, 'Alpha then Beta.', {
      summary: 'Correct both names.',
      edits: [
        { oldText: 'Alpha', newText: 'Beta' },
        { oldText: 'Beta.', newText: 'Gamma.' },
      ],
    })?.content,
    'Beta then Gamma.'
  )
})

test('ambiguous, missing and overlapping passages reject the entire patch', () => {
  for (const edits of [
    [{ oldText: 'same', newText: 'new' }],
    [{ oldText: 'absent', newText: 'new' }],
    [
      { oldText: 'same twice', newText: 'new' },
      { oldText: 'twice', newText: 'changed' },
    ],
  ])
    assert.throws(
      () => materializeDayWikiEdits(candidate, 'same twice, same again', { summary: 'Change.', edits }),
      /agent-invalid-response/
    )
})

test('no edits and unchanged edits are no-ops; metadata injection and empty page replacement reject', () => {
  assert.equal(materializeDayWikiEdits(candidate, 'Current.', { summary: '', edits: [] }), null)
  assert.equal(
    materializeDayWikiEdits(candidate, 'Current.', {
      summary: '',
      edits: [{ oldText: 'Current.', newText: 'Current.' }],
    }),
    null
  )
  for (const newText of ['', '<!-- remember-managed:end -->']) {
    assert.throws(
      () =>
        materializeDayWikiEdits(candidate, 'Current.', {
          summary: 'Change.',
          edits: [{ oldText: 'Current.', newText }],
        }),
      /agent-invalid-response/
    )
  }
})

test('patching receives only the managed region, leaving human text and source metadata outside it', () => {
  assert.equal(
    dayWikiManagedBody(
      '# Trip\n\nHuman note.\n\n<!-- remember-managed:start -->\nManaged.\n<!-- remember-managed:end -->\n<!-- remember-source:private -->'
    ),
    'Managed.'
  )
  assert.equal(dayWikiManagedBody('# A human-authored page\n\nNo managed region.'), null)
})

test('a failed exact edit defers Wiki work without failing the completed Day', async () => {
  const deferred: string[] = []
  const result = await generateOptionalDayWikiUpdates({
    suggestions: [candidate],
    review: async () => {
      materializeDayWikiEdits(candidate, 'Current text.', {
        summary: 'Change the route.',
        edits: [{ oldText: 'Invented previous text.', newText: 'New route.' }],
      })
      return [candidate]
    },
    onDeferred: (stage, code) => deferred.push(`${stage}:${code}`),
  })
  assert.deepEqual(result, [])
  assert.deepEqual(deferred, ['review:agent-invalid-response'])
})

test('external whitespace changes to ownership markers still require exact edits', () => {
  for (const spacing of ['', ' ', '\t', '   ']) {
    const page = `Human note.\r\n<!--${spacing}remember-managed:start${spacing}-->\r\nExisting durable details.\r\n<!--${spacing}remember-managed:end${spacing}-->`
    assert.equal(dayWikiManagedBody(page), 'Existing durable details.')
  }
  for (const page of [
    '<!--remember-managed:start-->Unclosed body.',
    '<!--remember-managed:end-->Orphan end.',
    '<!--remember-managed:start-- Broken comment.',
    '<!--remember-managed:start-->One<!--remember-managed:end--><!--remember-managed:start-->Two<!--remember-managed:end-->',
  ])
    assert.throws(() => dayWikiManagedBody(page), /agent-invalid-response/)
})
