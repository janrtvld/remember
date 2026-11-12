import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  type ProactiveContextInput,
  parseProactivePlan,
  proactiveModelContract,
  proactiveModelForCatalog,
  projectProactiveContext,
} from '../proactivePolicy'
import type { ProactiveSource } from '../proactiveStore'

const now = Date.parse('2026-10-23T10:00:00.000Z')
const text = 'Atlas compile error: missing route handler.'
function source(overrides: Partial<ProactiveSource> = {}): ProactiveSource {
  return {
    kind: 'context',
    sourceId: 'screen',
    evidenceId: 'screen',
    revision: 'text-hash',
    workdayId: 'day',
    observedAt: now - 10_000,
    text,
    source: 'screen',
    appName: 'Editor',
    bundleId: 'test.editor',
    windowTitle: 'Atlas',
    url: '',
    eventId: 'event-screen',
    sequence: 1,
    eventRevision: 'event-hash',
    acceptedAt: now - 9_000,
    contentKey: 'content-hash',
    provenance: { speaker: 'unknown', mediaPlayback: 'unknown', inputRoute: 'screen' },
    ...overrides,
  }
}
function input(overrides: Partial<ProactiveContextInput> = {}): ProactiveContextInput {
  return { evidence: [source()], items: [], locale: 'nl', now, timeZone: 'Europe/Amsterdam', ...overrides }
}
function output(overrides: Record<string, unknown> = {}) {
  return {
    consideredEvidenceIds: ['screen'],
    proposed: [],
    changes: [],
    initiative: {
      kind: 'offer',
      text: 'Ik kan helpen de ontbrekende route-handler te vinden.',
      topicKey: 'atlas-handler',
      sourceIds: ['screen'],
      supportingQuotes: [{ sourceId: 'screen', quote: text }],
      ...overrides,
    },
  }
}

test('one useful initiative retains exact source support without inventing a Task', () => {
  const result = parseProactivePlan(output(), input())
  assert.equal(result.initiative.kind, 'offer')
  assert.deepEqual(result.initiative.sourceIds, ['screen'])
  assert.deepEqual(result.initiative.supportingQuotes, [{ sourceId: 'screen', quote: text }])
  assert.deepEqual(result.taskPlan.proposed, [])
  assert.deepEqual(result.taskPlan.changes, [])
})

test('unknown, unconsidered, duplicate and uncited IDs reject', () => {
  for (const changed of [
    output({ sourceIds: ['invented'] }),
    { ...output(), consideredEvidenceIds: ['other'] },
    output({ sourceIds: ['screen', 'screen'] }),
    output({ supportingQuotes: [] }),
    output({ supportingQuotes: [{ sourceId: 'other', quote: text }] }),
  ])
    assert.throws(() => parseProactivePlan(changed, input()), /proactive-invalid-response/)
})

test('paraphrased, clipped and empty support cannot impersonate a source quote', () => {
  for (const quote of ['Atlas error: missing endpoint.', '', text.toLowerCase()]) {
    assert.throws(
      () => parseProactivePlan(output({ supportingQuotes: [{ sourceId: 'screen', quote }] }), input()),
      /proactive-invalid-response/
    )
  }
})

test('unexpected authority, time, revision and payload keys reject', () => {
  for (const changed of [
    { ...output(), permission: true },
    output({ expiresAt: now + 60_000 }),
    output({ revision: 'model-hash' }),
    output({ kind: 'execute' }),
    output({ text: 'x'.repeat(801) }),
    output({ text: '' }),
  ])
    assert.throws(() => parseProactivePlan(changed, input()), /proactive-invalid-response/)
})

test('a delayed old import is considered silently even when the model asks to surface it', () => {
  const result = parseProactivePlan(
    output(),
    input({ evidence: [source({ observedAt: now - 3 * 86_400_000, acceptedAt: now })] })
  )
  assert.equal(result.initiative.kind, 'silent')
  assert.deepEqual(result.taskPlan.consideredEvidenceIds, ['screen'])
  assert.equal(result.initiative.text, '')
})

test('the exact two-minute attention horizon is determined by code', () => {
  assert.equal(
    parseProactivePlan(output(), input({ evidence: [source({ observedAt: now - 120_000 })] })).initiative.kind,
    'offer'
  )
  assert.equal(
    parseProactivePlan(output(), input({ evidence: [source({ observedAt: now - 120_001 })] })).initiative.kind,
    'silent'
  )
})

test('future observation time is not clamped into a fresh event', () => {
  const context = input({ evidence: [source({ observedAt: now + 1_000 })] })
  assert.equal(projectProactiveContext(context).evidence[0].ageMs, -1_000)
  assert.equal(projectProactiveContext(context).evidence[0].freshness, 'future')
  assert.equal(parseProactivePlan(output(), context).initiative.kind, 'silent')
})

test('code projects the real UTC and local clock instead of asking for timezone arithmetic', () => {
  const projection = projectProactiveContext(input())
  assert.equal(projection.clock.utc, '2026-10-23T10:00:00.000Z')
  assert.match(projection.clock.local, /12:00:00/)
  assert.equal(projection.clock.timeZone, 'Europe/Amsterdam')
  assert.equal(projection.evidence[0].ageMs, 10_000)
  assert.equal(projection.evidence[0].freshness, 'fresh')
  assert.equal('revision' in projection.evidence[0], false)
  assert.equal('eventRevision' in projection.evidence[0], false)
})

test('native unknown speaker and media remain unknown for microphone input', () => {
  const speech = source({
    kind: 'speech',
    evidenceId: 'speech:screen',
    source: 'microphone',
    provenance: { speaker: 'unknown', mediaPlayback: 'unknown', inputRoute: 'microphone' },
  })
  const projection = projectProactiveContext(input({ evidence: [speech] }))
  assert.deepEqual(projection.evidence[0].provenance, speech.provenance)
  assert.equal(projection.evidence[0].provenance.speaker, 'unknown')
})

test('positively linked playback is not a trigger or a personal Task source', () => {
  const playback = source({ provenance: { speaker: 'unknown', mediaPlayback: 'recorded', inputRoute: 'system' } })
  const result = parseProactivePlan(output(), input({ evidence: [playback] }))
  assert.equal(result.initiative.kind, 'silent')
  assert.deepEqual(result.taskPlan.proposed, [])
})

test('current explicit dismissal suppresses a repeated topic; expiry permits a new offer', () => {
  const conversation = {
    generation: 2,
    recentMessages: [],
    dismissedTopics: [{ topicKey: 'atlas-handler', dismissedAt: now - 100, expiresAt: now + 100 }],
  }
  assert.equal(parseProactivePlan(output(), input({ conversation })).initiative.kind, 'silent')
  const dismissal = conversation.dismissedTopics[0]
  assert(dismissal)
  dismissal.expiresAt = now - 1
  assert.equal(parseProactivePlan(output(), input({ conversation })).initiative.kind, 'offer')
})

test('prepare can only become an offer and never returns a grant or execution authority', () => {
  const result = parseProactivePlan(output({ kind: 'prepare' }), input())
  assert.equal(result.initiative.kind, 'offer')
  assert.equal('grantId' in result.initiative, false)
  assert.equal('preparation' in result.initiative, false)
})

test('user context reaches the model as background and stays out of citable sources', () => {
  const projection = projectProactiveContext(
    input({
      userContext: {
        profile: { title: 'Me', content: 'Leads the Harbor launch. Prefers short Dutch replies.', updatedAt: now },
        activity: null,
      },
    })
  )
  assert.equal(projection.userContext?.profile?.content, 'Leads the Harbor launch. Prefers short Dutch replies.')
  assert.equal(
    projection.evidence.some((entry) => entry.text.includes('Harbor launch')),
    false
  )
  assert.equal(projectProactiveContext(input()).userContext, null)
})

test('computer capability context does not grant preparation or execution', () => {
  const context = input({ agentComputer: 'remote' })
  assert.deepEqual(projectProactiveContext(context).capabilities, { agentComputer: 'remote' })
  const result = parseProactivePlan(output({ kind: 'prepare' }), context)
  assert.equal(result.initiative.kind, 'offer')
  assert.equal('preparation' in result.initiative, false)
  assert.equal('grantId' in result.initiative, false)
})

test('background model selection stays in the available efficient tier', () => {
  const model = (id: string, efforts = ['low']) => ({
    model: id,
    displayName: id,
    supportedReasoningEfforts: efforts,
    defaultReasoningEffort: efforts[0],
  })
  assert.equal(proactiveModelForCatalog([model('gpt-5.6-luna'), model('gpt-6-luna')]), 'gpt-6-luna')
  assert.equal(proactiveModelForCatalog([model('gpt-5.6-luna')]), 'gpt-5.6-luna')
  assert.equal(proactiveModelForCatalog([model('gpt-6-astra'), model('gpt-6.1-sol')]), null)
  assert.equal(proactiveModelForCatalog([model('gpt-6-luna', ['high'])]), null)
})

test('silent output is empty while source consideration remains durable metadata', () => {
  const result = parseProactivePlan(
    output({ kind: 'silent', text: '', topicKey: '', sourceIds: [], supportingQuotes: [] }),
    input()
  )
  assert.equal(result.initiative.kind, 'silent')
  assert.deepEqual(result.taskPlan.consideredEvidenceIds, ['screen'])
  assert.throws(() => parseProactivePlan(output({ kind: 'silent' }), input()), /proactive-invalid-response/)
})

test('projection snapshots inputs across a later caller mutation', () => {
  const context = input({
    conversation: {
      generation: 3,
      recentMessages: [{ id: 'u1', role: 'user', text: 'Use the current handler.', createdAt: now - 500 }],
      dismissedTopics: [],
    },
  })
  const projection = projectProactiveContext(context)
  const original = context.evidence[0]
  const message = context.conversation?.recentMessages[0]
  assert(original && message)
  original.text = 'Changed after projection'
  original.provenance.inputRoute = 'changed'
  message.text = 'Changed user instruction'
  assert.equal(projection.evidence[0].text, text)
  assert.equal(projection.evidence[0].provenance.inputRoute, 'screen')
  assert.equal(projection.conversation.recentMessages[0].text, 'Use the current handler.')
})

test('source and conversation projection redact credentials and strip URL queries', () => {
  const projection = projectProactiveContext(
    input({
      evidence: [
        source({
          text: 'The request failed with Bearer synthetic-token.',
          url: 'https://example.test/editor?code=synthetic-code#debug',
        }),
      ],
      conversation: {
        generation: 1,
        recentMessages: [
          {
            id: 'u1',
            role: 'user',
            text: 'The copied header was Bearer synthetic-token.',
            createdAt: now,
          },
        ],
        dismissedTopics: [],
      },
    })
  )
  assert.equal(JSON.stringify(projection).includes('synthetic-token'), false)
  assert.equal(JSON.stringify(projection).includes('synthetic-code'), false)
  assert.equal(projection.evidence[0]?.url, 'https://example.test/editor')
})

test('existing Task support keeps a real named request and rejects an unknown first-person speaker', () => {
  const speechText = 'Jan, kun jij de route-handler nalopen?'
  const speech = source({
    kind: 'speech',
    evidenceId: 'speech:screen',
    text: speechText,
    source: 'microphone',
    provenance: { speaker: 'unknown', mediaPlayback: 'unknown', inputRoute: 'microphone' },
  })
  const proposal = {
    id: null,
    title: 'Route-handler nalopen',
    description: 'Controleer de ontbrekende route-handler.',
    prompt: '',
    aiSuggestion: null,
    context: speechText,
    returnPoint: { lastMove: '', unresolved: '', nextMove: 'Route-handler nalopen' },
    source: {
      kind: 'task',
      evidenceId: 'speech:screen',
      label: 'Atlas',
      detail: 'Direct verzoek',
      conversationStartTime: null,
    },
    evidenceQuote: speechText,
    ownership: 'user',
    notify: false,
  }
  const candidate = {
    consideredEvidenceIds: ['speech:screen'],
    proposed: [proposal],
    changes: [],
    initiative: { kind: 'silent', text: '', topicKey: '', sourceIds: [], supportingQuotes: [] },
  }
  assert.equal(
    parseProactivePlan(candidate, input({ evidence: [speech], userName: 'Jan' })).taskPlan.proposed.length,
    1
  )
  const firstPerson = 'Ik zal de route-handler nalopen.'
  const unowned = { ...candidate, proposed: [{ ...proposal, evidenceQuote: firstPerson }] }
  assert.equal(
    parseProactivePlan(unowned, input({ evidence: [{ ...speech, text: firstPerson }], userName: 'Jan' })).taskPlan
      .proposed.length,
    0
  )
  const playback = { ...speech, provenance: { ...speech.provenance, mediaPlayback: 'recorded' as const } }
  assert.equal(
    parseProactivePlan(candidate, input({ evidence: [playback], userName: 'Jan' })).taskPlan.proposed.length,
    0
  )
})

test('invalid clocks, duplicate source IDs and oversized sources reject before a provider call', () => {
  for (const context of [
    input({ now: NaN }),
    input({ evidence: [source(), source()] }),
    input({ evidence: [source({ text: 'x'.repeat(48_001) })] }),
  ]) {
    assert.throws(() => projectProactiveContext(context), /proactive-invalid-input/)
  }
})

test('saved Note input cannot nominate a private briefing or prepare even with caller-supplied candidate IDs', () => {
  const note = source({ kind: 'note', evidenceId: 'note:screen', workdayId: '', source: 'saved-note' })
  const noteInput = input({ evidence: [note] })
  const noteOutput = {
    ...output(),
    consideredEvidenceIds: [note.evidenceId],
    initiative: {
      ...output().initiative,
      sourceIds: [note.evidenceId],
      supportingQuotes: [{ sourceId: note.evidenceId, quote: text }],
    },
  }
  assert.deepEqual(parseProactivePlan(noteOutput, noteInput).taskPlan.proposed, [])
  for (const kind of ['prepare', 'private-briefing']) {
    assert.throws(
      () => parseProactivePlan({ ...noteOutput, initiative: { ...noteOutput.initiative, kind } }, noteInput),
      /proactive-invalid-response/
    )
  }
  assert.throws(
    () => projectProactiveContext({ ...noteInput, briefingCandidateSourceIds: [note.evidenceId] }),
    /proactive-invalid-input/
  )
})

test('Note Task fields and mixed capture batches fail closed', () => {
  const note = source({ kind: 'note', evidenceId: 'note:screen', workdayId: '', source: 'saved-note' })
  const noteInput = input({ evidence: [note] })
  for (const key of ['proposed', 'changes']) {
    assert.throws(
      () => parseProactivePlan({ ...output(), consideredEvidenceIds: [note.evidenceId], [key]: [{}] }, noteInput),
      /proactive-invalid-response/
    )
  }
  assert.throws(() => projectProactiveContext(input({ evidence: [source(), note] })), /proactive-invalid-input/)
})

function dayInput() {
  const evidence = source({
    kind: 'day',
    evidenceId: 'day:2026-10-23',
    source: 'day-sync',
    text: JSON.stringify({
      kind: 'derived-day-state',
      tasks: [
        {
          id: 'motivation',
          title: 'Motivatie over concrete projectervaring schrijven',
          lifecycle: 'open',
          proactiveEligible: true,
        },
      ],
      day: {
        summary: 'Sollicitatie voorbereiden',
        openTasks: ['Motivatie over concrete projectervaring schrijven'],
      },
      previous: { summary: 'CV bijwerken' },
    }),
    provenance: { speaker: 'unknown', mediaPlayback: 'unknown', inputRoute: 'day-sync' },
  })
  return input({ evidence: [evidence] })
}

function dayOutput() {
  return {
    consideredEvidenceIds: ['day:2026-10-23'],
    followUps: [],
    proposed: [],
    changes: [],
    initiative: {
      kind: 'observe',
      text: 'Gebruik voor je motivatie één projectvoorbeeld met drie onderdelen: het probleem, jouw bijdrage en het resultaat.',
      topicKey: 'motivatie-projectervaring',
      taskIds: ['motivation'],
      sourceIds: ['day:2026-10-23'],
      supportingQuotes: [{ sourceId: 'day:2026-10-23', quote: 'Motivatie over concrete projectervaring schrijven' }],
    },
  }
}

test('derived Day state supports grounded help without a second Task extraction pass', () => {
  const context = dayInput()
  const result = parseProactivePlan(dayOutput(), context)
  assert.equal(result.initiative.kind, 'observe')
  assert.deepEqual(result.taskPlan, {
    consideredEvidenceIds: ['day:2026-10-23'],
    proposed: [],
    changes: [],
    notifyTitles: [],
  })
  const contract = proactiveModelContract(context)
  assert.equal(contract.schema.properties.proposed.maxItems, 0)
  assert.equal(contract.schema.properties.changes.maxItems, 0)
  assert.deepEqual(contract.schema.properties.initiative.properties.kind.enum, [
    'silent',
    'observe',
    'clarify',
    'offer',
  ])
})

test('a missing Task identifier can bind only to one exact user-adopted quote', () => {
  const context = dayInput()
  const evidence = context.evidence[0]
  assert(evidence)
  const state = JSON.parse(evidence.text)
  state.tasks[0].userOwned = true
  evidence.text = JSON.stringify(state)
  const response = dayOutput()
  response.initiative.taskIds = []
  const bound = parseProactivePlan(response, context)
  assert.deepEqual(bound.initiative.taskIds, ['motivation'])
  assert.equal(bound.initiative.topicKey, 'task:motivation')
  assert.deepEqual(bound.taskPlan.proposed, [])
  for (const change of [
    () => {
      state.tasks[0].userOwned = false
    },
    () => {
      state.tasks[0].userOwned = true
      state.tasks[0].lifecycle = 'completed'
    },
    () => {
      state.tasks[0].lifecycle = 'open'
      state.tasks.push({ ...state.tasks[0], id: 'ambiguous' })
    },
  ]) {
    change()
    evidence.text = JSON.stringify(state)
    assert.throws(() => parseProactivePlan(response, context), /proactive-invalid-response/)
  }
})

test('Day input cannot create or complete Tasks, nominate execution, or mix with raw capture', () => {
  const context = dayInput()
  const plan = dayOutput()
  for (const key of ['proposed', 'changes']) {
    assert.throws(() => parseProactivePlan({ ...plan, [key]: [{}] }, context), /proactive-invalid-response/)
  }
  for (const kind of ['prepare', 'private-briefing']) {
    assert.throws(
      () => parseProactivePlan({ ...plan, initiative: { ...plan.initiative, kind } }, context),
      /proactive-invalid-response/
    )
  }
  assert.throws(
    () => projectProactiveContext({ ...context, briefingCandidateSourceIds: ['day:2026-10-23'] }),
    /proactive-invalid-input/
  )
  assert.throws(
    () => projectProactiveContext({ ...context, evidence: [...context.evidence, source()] }),
    /proactive-invalid-input/
  )
})

test('Day attention survives a user turn but expires after the stored snapshot horizon', () => {
  const context = dayInput()
  const evidence = context.evidence[0]
  assert(evidence)
  evidence.observedAt = now - 30 * 60_000
  assert.equal(parseProactivePlan(dayOutput(), context).initiative.kind, 'observe')
  evidence.observedAt = now - 86_400_001
  assert.equal(parseProactivePlan(dayOutput(), context).initiative.kind, 'silent')
})

test('Day silence is a valid considered result and unsupported quotes still reject', () => {
  const context = dayInput()
  const plan = dayOutput()
  const silent = parseProactivePlan(
    {
      ...plan,
      initiative: { kind: 'silent', text: '', topicKey: '', taskIds: [], sourceIds: [], supportingQuotes: [] },
    },
    context
  )
  assert.deepEqual(silent.taskPlan.consideredEvidenceIds, ['day:2026-10-23'])
  assert.equal(silent.initiative.kind, 'silent')
  assert.throws(
    () =>
      parseProactivePlan(
        {
          ...plan,
          initiative: {
            ...plan.initiative,
            supportingQuotes: [{ sourceId: 'day:2026-10-23', quote: 'Drie sollicitaties zijn verzonden.' }],
          },
        },
        context
      ),
    /proactive-invalid-response/
  )
})

test('task identity cannot be renamed to bypass a dismissal', () => {
  const context = dayInput()
  context.conversation = {
    generation: 1,
    recentMessages: [],
    dismissedTopics: [{ topicKey: 'task:motivation', dismissedAt: now - 1, expiresAt: now + 86_400_000 }],
  }
  assert.equal(parseProactivePlan(dayOutput(), context).initiative.kind, 'silent')
  context.conversation.dismissedTopics = []
  assert.equal(parseProactivePlan(dayOutput(), context).initiative.topicKey, 'task:motivation')
})

test('Day follow-up memory can survive a silent decision but never promote ineligible or closed tasks', () => {
  const context = dayInput()
  const plan = {
    ...dayOutput(),
    followUps: [
      {
        taskId: 'motivation',
        note: 'Check whether the introduction still needs a concrete example.',
        nextReviewAt: now + 60_000,
      },
    ],
  }
  const result = parseProactivePlan(plan, context)
  assert.equal(result.followUps?.[0]?.nextReviewAt, now + 3 * 60 * 60_000)
  const evidence = context.evidence[0]
  assert(evidence)
  const state = JSON.parse(evidence.text)
  state.tasks[0].proactiveEligible = false
  evidence.text = JSON.stringify(state)
  assert.throws(() => parseProactivePlan(plan, context), /proactive-invalid-response/)
  assert.equal(parseProactivePlan(dayOutput(), context).initiative.kind, 'silent')
  state.tasks[0].lifecycle = 'completed'
  evidence.text = JSON.stringify(state)
  assert.throws(() => parseProactivePlan(dayOutput(), context), /proactive-invalid-response/)
})

test('Day task and follow-up identities must exist in current supplied sources', () => {
  const context = dayInput()
  const plan = dayOutput()
  for (const taskIds of [[], ['invented'], ['motivation', 'motivation']])
    assert.throws(
      () => parseProactivePlan({ ...plan, initiative: { ...plan.initiative, taskIds } }, context),
      /proactive-invalid-response/
    )
  for (const followUps of [
    [{ taskId: 'invented', note: 'Follow up.', nextReviewAt: now + 60_000 }],
    [{ taskId: 'motivation', note: 'Follow up.', nextReviewAt: now - 1 }],
    [{ taskId: 'motivation', note: 'Follow up.', nextReviewAt: now + 60_000, permission: true }],
  ])
    assert.throws(() => parseProactivePlan({ ...plan, followUps }, context), /proactive-invalid-response/)
})

test('a Day statement cannot masquerade as evidence for an unrelated eligible task', () => {
  const plan = dayOutput()
  plan.initiative.supportingQuotes = [{ sourceId: 'day:2026-10-23', quote: 'Sollicitatie voorbereiden' }]
  assert.throws(() => parseProactivePlan(plan, dayInput()), /proactive-invalid-response/)
})

test('deadline urgency uses the actual clock without changing immutable source text', () => {
  const context = dayInput()
  const evidence = context.evidence[0]
  assert(evidence)
  const state = JSON.parse(evidence.text)
  state.tasks[0].dueAt = now + 2 * 60 * 60_000
  evidence.text = JSON.stringify(state)
  const original = evidence.text
  assert.equal(projectProactiveContext(context).taskTiming[0]?.phase, 'due-within-three-hours')
  assert.equal(projectProactiveContext({ ...context, now: now + 3 * 60 * 60_000 }).taskTiming[0]?.phase, 'overdue')
  assert.equal(evidence.text, original)
})

test('a current Day with no Tasks supports a concrete conversational offer', () => {
  const context = dayInput()
  const source = context.evidence[0]
  assert(source)
  source.text = JSON.stringify({
    day: { summary: 'Jan vergelijkt drie films voor een filmavond met vrienden.' },
    tasks: [],
  })
  context.locale = 'en'
  context.conversation = {
    generation: 1,
    recentMessages: [
      { id: 'user', role: 'user', text: 'Ik zoek iets leuks voor een filmavond.', createdAt: now - 1000 },
    ],
    dismissedTopics: [],
  }
  const plan = dayOutput()
  plan.initiative = {
    ...plan.initiative,
    kind: 'offer',
    text: 'Zal ik de drie films kort naast elkaar zetten, zodat jullie makkelijker kunnen kiezen?',
    taskIds: [],
    topicKey: 'Filmavond keuze',
    supportingQuotes: [
      { sourceId: source.evidenceId, quote: 'Jan vergelijkt drie films voor een filmavond met vrienden.' },
    ],
  }
  const parsed = parseProactivePlan(plan, context)
  assert.equal(parsed.initiative.kind, 'offer')
  assert.equal(parsed.initiative.topicKey, 'context:filmavond keuze')
  assert.deepEqual(parsed.initiative.taskIds, [])
  assert.deepEqual(parsed.taskPlan.proposed, [])
  assert.match(proactiveModelContract(context).systemPrompt, /language of the latest substantive user message/)
  context.conversation.dismissedTopics.push({
    topicKey: parsed.initiative.topicKey,
    dismissedAt: now,
    expiresAt: now + 86_400_000,
  })
  assert.equal(parseProactivePlan(plan, context).initiative.kind, 'silent')
})

test('contextual offers cannot use Tasks, omitted Day context or historical comparison as their sole evidence', () => {
  const plan = dayOutput()
  plan.initiative.taskIds = []
  assert.throws(() => parseProactivePlan(plan, dayInput()), /proactive-invalid-response/)
  const quote = 'Een filmavond met vrienden voorbereiden'
  plan.initiative.supportingQuotes = [{ sourceId: 'day:2026-10-23', quote }]
  for (const state of [
    { day: {}, previous: { summary: quote }, tasks: [] },
    { day: { summary: quote }, daySummaryOmitted: true, tasks: [] },
    { day: { summary: quote }, tasks: [{ id: 'closed', title: quote, lifecycle: 'completed' }] },
    { day: { summary: quote }, tasks: [{ id: 'excluded', title: quote, lifecycle: 'open', proactiveEligible: false }] },
  ]) {
    const context = dayInput()
    const source = context.evidence[0]
    assert(source)
    source.text = JSON.stringify(state)
    assert.throws(() => parseProactivePlan(plan, context), /proactive-invalid-response/)
  }
})
