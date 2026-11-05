import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { agentErrorDetail } from '../agentErrors'
import { claudeResponseFailure, parseClaudeResponse } from '../agentResponse'
import { parseClaudeDayMemory, parseClaudeShardAnalysis, parseDayMemory, parseShardAnalysis } from '../analysisFormat'
import { CONTEXT_IMPORT_SCHEMA, FINAL_ANALYSIS_SCHEMA, TIMELINE_WIKI_SCHEMA } from '../analysisSchemas'

const memoryJson = JSON.stringify({
  summary: ' Finished the release. ',
  currentFocus: ' Verify rollout ',
  outcomes: [' Shipped version 1 ', ' '],
  decisions: [' Release on Friday '],
  openLoops: [' Verify usage reporting '],
  openTasks: [
    {
      title: ' Verify usage reporting ',
      description: ' Confirm that successful calls appear in the dashboard. ',
      prompt: ' Check reporting and confirm whether successful calls appear in the dashboard. ',
      context: ' The release is live, but successful calls have not yet been verified in reporting. ',
      returnPoint: {
        lastMove: ' The release was published. ',
        unresolved: ' Successful usage has not appeared in reporting yet. ',
        nextMove: ' Check the reporting dashboard for one successful call. ',
      },
      source: {
        kind: 'task',
        label: ' Usage reporting ',
        detail: ' The verification step remained unfinished after the release. ',
        evidenceId: ' context-usage-reporting ',
      },
    },
  ],
  projectAttention: [{ project: ' Remember ', durationMinutes: 91.4, description: ' Finished the release flow. ' }],
  conversations: [
    {
      startTime: '11:30',
      endTime: '12:00',
      title: ' Pricing call ',
      description: ' Agreed on Friday. ',
      summary: ' Discussed the rollout constraints and agreed to release on Friday. ',
      actionPoints: [' Send the final proposal ', ' '],
    },
  ],
  knowledgeSuggestions: [
    {
      slug: 'processes/release-process',
      title: ' Release process ',
      content: ' ## Current state\n\nUse the signed build. ',
      summary: ' Use the signed build. ',
      changeType: 'created',
      suggestedSpaceId: ' finance-wiki ',
    },
  ],
  timeline: [
    { startTime: '10:30', endTime: '11:00', title: ' Review ', description: ' Checked pricing. ' },
    { startTime: '09:00', endTime: '10:00', title: ' Build ', description: ' Finished release. ' },
  ],
})

describe('parseDayMemory', () => {
  it('allows complete Wiki pages through each generation schema and preserves them through both Day parsers', () => {
    const content = [
      '## Decisions',
      ...Array.from(
        { length: 180 },
        (_, index) =>
          `- Decision ${index + 1}: Preserve the agreed constraint and its rationale when maintaining the existing project page.`
      ),
      '## Remaining work',
      'Confirm the final reservation before changing the agreed itinerary.',
    ].join('\n\n')
    assert.ok(content.length > 17_000)

    for (const schema of [
      FINAL_ANALYSIS_SCHEMA.properties.knowledgeSuggestions.items.properties.content,
      CONTEXT_IMPORT_SCHEMA.properties.pages.items.properties.content,
      TIMELINE_WIKI_SCHEMA.properties.pages.items.properties.content,
    ]) {
      assert.equal(schema.type, 'string')
      assert.equal(
        'maxLength' in schema,
        false,
        'Complete existing Wiki pages must not be constrained to a shorter body'
      )
    }

    const value = JSON.parse(memoryJson)
    value.knowledgeSuggestions[0].content = content
    value.knowledgeSuggestions[0].changeType = 'updated'
    for (const memory of [
      parseDayMemory(JSON.stringify(value)),
      parseClaudeDayMemory(JSON.stringify({ type: 'result', structured_output: value })),
    ]) {
      assert.equal(memory.knowledgeSuggestions[0]?.content, content)
      assert.ok(
        memory.knowledgeSuggestions[0]?.content?.endsWith(
          'Confirm the final reservation before changing the agreed itinerary.'
        )
      )
    }
  })

  it('preserves explicit personal tasks and normalizes AI offers without inferring from old prompts', () => {
    const memory = parseDayMemory(
      JSON.stringify({
        summary: 'Outstanding commitments.',
        openTasks: [
          { title: 'Swap suitcase with Tom', description: 'Before the trip.', prompt: 'Old brief', aiSuggestion: null },
          {
            title: 'Make a PDF',
            description: 'Collect the answers.',
            aiSuggestion: ' Want me to make a PDF with the answers? ',
          },
          { title: 'Legacy task', description: 'Not classified yet.', prompt: 'Old AI brief' },
          { title: 'Empty offer', description: 'No AI work.', aiSuggestion: '  ', prompt: '  ' },
        ].map((task) => ({
          ...task,
          source: { kind: 'task', label: 'Commitment', detail: 'Still outstanding.', evidenceId: 'screen-evidence' },
        })),
      })
    )
    assert.deepEqual(
      memory.openTasks?.map((task) => task.aiSuggestion),
      [null, 'Want me to make a PDF with the answers?', undefined, null]
    )
    assert.deepEqual(
      memory.openTasks?.map((task) => task.prompt),
      ['Old brief', undefined, 'Old AI brief', '']
    )
  })

  it('accepts and normalizes a living day memory', () => {
    const memory = parseDayMemory(memoryJson)
    assert.equal(memory.summary, 'Finished the release.')
    assert.equal(memory.currentFocus, null)
    assert.deepEqual(memory.outcomes, ['Shipped version 1'])
    assert.deepEqual(memory.openLoops, ['Verify usage reporting'])
    assert.deepEqual(memory.openTasks, [
      {
        title: 'Verify usage reporting',
        description: 'Confirm that successful calls appear in the dashboard.',
        prompt: 'Check reporting and confirm whether successful calls appear in the dashboard.',
        context: 'The release is live, but successful calls have not yet been verified in reporting.',
        returnPoint: {
          lastMove: 'The release was published.',
          unresolved: 'Successful usage has not appeared in reporting yet.',
          nextMove: 'Check the reporting dashboard for one successful call.',
        },
        source: {
          kind: 'task',
          label: 'Usage reporting',
          detail: 'The verification step remained unfinished after the release.',
          evidenceId: 'context-usage-reporting',
        },
      },
    ])
    assert.deepEqual(memory.projectAttention, [
      { project: 'Remember', durationMinutes: 91, description: 'Finished the release flow.' },
    ])
    assert.equal(memory.conversations[0]?.title, 'Pricing call')
    assert.equal(memory.conversations[0]?.summary, 'Discussed the rollout constraints and agreed to release on Friday.')
    assert.deepEqual(memory.conversations[0]?.actionPoints, ['Send the final proposal'])
    assert.equal(memory.knowledgeSuggestions[0]?.suggestedSpaceId, 'finance-wiki')
    assert.equal(memory.knowledgeSuggestions[0]?.content, '## Current state\n\nUse the signed build.')
    assert.deepEqual(
      memory.timeline.map((block) => block.title),
      ['Build', 'Review']
    )
  })

  it('keeps grounded actions and drops source-less generated tasks', () => {
    const value = JSON.parse(memoryJson)
    value.currentFocus = null
    value.openTasks.push(
      {
        title: 'Second action',
        description: 'Complete the second result.',
        source: {
          kind: 'task',
          label: 'Second workflow',
          detail: 'Concrete residual work remains.',
          evidenceId: 'context-second-action',
        },
      },
      { title: 'Third action', description: 'Complete the third result.' }
    )

    const memory = parseDayMemory(JSON.stringify(value))

    assert.deepEqual(
      memory.openTasks?.map((task) => task.title),
      ['Verify usage reporting', 'Second action']
    )
  })

  it('keeps a valid conversation start time for a linkable action-point source', () => {
    const value = JSON.parse(memoryJson)
    value.openTasks[0].source = {
      kind: 'conversation',
      label: ' Pricing call ',
      detail: ' Explicit follow-up from the conversation. ',
      conversationStartTime: '11:30',
    }

    assert.deepEqual(parseDayMemory(JSON.stringify(value)).openTasks?.[0]?.source, {
      kind: 'conversation',
      label: 'Pricing call',
      detail: 'Explicit follow-up from the conversation.',
      conversationStartTime: '11:30',
    })
  })

  it('keeps legacy Personal Wiki updates private by default', () => {
    const value = JSON.parse(memoryJson)
    value.knowledgeSuggestions[0].suggestedSpaceId = undefined

    assert.equal(parseDayMemory(JSON.stringify(value)).knowledgeSuggestions[0]?.suggestedSpaceId, null)
  })

  it('accepts nested Wiki pages', () => {
    const value = JSON.parse(memoryJson)
    value.knowledgeSuggestions[0] = {
      ...value.knowledgeSuggestions[0],
      slug: 'projects/remember/wiki/navigation',
    }

    assert.equal(
      parseDayMemory(JSON.stringify(value)).knowledgeSuggestions[0]?.slug,
      'projects/remember/wiki/navigation'
    )
  })

  it('accepts the nullable replacement title required by strict structured output', () => {
    const value = JSON.parse(memoryJson)
    value.taskChanges = [
      {
        id: 'work-item-usage-reporting',
        title: 'Verify usage reporting',
        type: 'completed',
        reason: 'The verification result was recorded.',
        replacementTitle: null,
      },
    ]

    assert.deepEqual(parseDayMemory(JSON.stringify(value)).taskChanges, [
      {
        id: 'work-item-usage-reporting',
        title: 'Verify usage reporting',
        type: 'completed',
        reason: 'The verification result was recorded.',
      },
    ])
  })

  it('reads JSON output from the Claude CLI envelope', () => {
    assert.equal(
      parseClaudeDayMemory(JSON.stringify({ is_error: false, structured_output: JSON.parse(memoryJson) })).summary,
      'Finished the release.'
    )
    assert.equal(
      parseClaudeDayMemory(JSON.stringify({ is_error: false, structured_output: memoryJson })).summary,
      'Finished the release.'
    )
  })

  it('unwraps placeholder and output keys generated by Claude', () => {
    for (const wrapper of ['$PARAMETER_NAME', 'output']) {
      assert.equal(
        parseClaudeDayMemory(
          JSON.stringify({
            is_error: false,
            result: JSON.stringify({ [wrapper]: JSON.parse(memoryJson) }),
          })
        ).summary,
        'Finished the release.'
      )
    }
  })

  it('recovers the malformed StructuredOutput tool payload emitted by Claude', () => {
    const output = JSON.stringify({
      is_error: false,
      result: JSON.stringify({
        StructuredOutput: '\n<parameter name="range">4 aug 2026, 12:17 – 12:32</parameter>',
        facts: 'Logged in and verified the account.',
        activities: '["Reviewed MCP registrations"]',
        audioConversations: '',
        outcomes: 'Fixed the import bug.',
        decisions: '[]',
        actionPoints: 'Run the release check.',
        openLoops: 'Confirm code verification.',
      }),
    })

    assert.deepEqual(parseClaudeResponse(output), {
      range: '4 aug 2026, 12:17 – 12:32',
      facts: 'Logged in and verified the account.',
      activities: '["Reviewed MCP registrations"]',
      audioConversations: '',
      outcomes: 'Fixed the import bug.',
      decisions: '[]',
      actionPoints: 'Run the release check.',
      openLoops: 'Confirm code verification.',
    })
    assert.deepEqual(parseClaudeShardAnalysis(output), {
      range: '4 aug 2026, 12:17 – 12:32',
      facts: ['Logged in and verified the account.'],
      activities: ['Reviewed MCP registrations'],
      audioConversations: [],
      outcomes: ['Fixed the import bug.'],
      decisions: [],
      actionPoints: ['Run the release check.'],
      openLoops: ['Confirm code verification.'],
    })
  })

  it('reads direct JSON from Claude plain-output mode', () => {
    assert.equal(parseClaudeDayMemory(JSON.stringify({ result: memoryJson })).summary, 'Finished the release.')
  })

  it('reads direct JSON from Codex without Claude transport handling', () => {
    const shard = {
      range: '5 aug 2026, 10:32–10:44 CEST',
      facts: [],
      activities: ['Reviewed logs.'],
      audioConversations: [],
      outcomes: [],
      decisions: [],
      actionPoints: [],
      openLoops: [],
    }

    assert.deepEqual(parseShardAnalysis(JSON.stringify(shard)), shard)
  })

  it('reads the terminal result from a Claude lifecycle event array', () => {
    const shard = {
      range: '5 aug 2026, 10:32–10:44 CEST',
      facts: ['Investigated the upload failure.'],
      activities: ['Reviewed logs.'],
      audioConversations: [],
      outcomes: ['Found the missing field.'],
      decisions: [],
      actionPoints: ['Patch the validator.'],
      openLoops: [],
    }
    const output = JSON.stringify([
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { content: [{ type: 'text', text: JSON.stringify(shard) }] } },
      { type: 'result', subtype: 'success', is_error: false, result: `\`\`\`json\n${JSON.stringify(shard)}\n\`\`\`` },
    ])

    assert.deepEqual(parseClaudeShardAnalysis(output), shard)
  })

  it('rejects a truncated Claude lifecycle stream without a terminal result', () => {
    const output = JSON.stringify([
      { type: 'system', subtype: 'init' },
      { type: 'assistant', message: { content: [{ type: 'text', text: '{"range":"partial"}' }] } },
    ])

    assert.throws(() => parseClaudeShardAnalysis(output), /agent-invalid-response/)
  })

  it('bounds recursive compatibility-wrapper normalization', () => {
    let payload: unknown = {
      range: '5 aug 2026',
      facts: [],
      activities: [],
      audioConversations: [],
      outcomes: [],
      decisions: [],
      actionPoints: [],
      openLoops: [],
    }
    for (let depth = 0; depth < 6; depth += 1) payload = { output: payload }

    assert.throws(() => parseClaudeShardAnalysis(JSON.stringify({ result: payload })), /agent-invalid-response/)
  })

  it('recognizes an expired Claude OAuth session', () => {
    const output = JSON.stringify({ is_error: true, result: 'Failed to authenticate: OAuth session expired' })
    assert.equal(claudeResponseFailure(output)?.code, 'claude-auth-required')
    assert.throws(() => parseClaudeDayMemory(output), /claude-auth-required/)
  })

  it('recognizes a terminal failure inside a Claude lifecycle event array', () => {
    const output = JSON.stringify([
      { type: 'system', subtype: 'init' },
      { type: 'result', subtype: 'error', is_error: true, result: 'OAuth session expired' },
    ])

    assert.equal(claudeResponseFailure(output)?.code, 'claude-auth-required')
    assert.throws(() => parseClaudeDayMemory(output), /claude-auth-required/)
  })

  it('recognizes a failure envelope nested in a successful terminal result', () => {
    const output = JSON.stringify({
      type: 'result',
      is_error: false,
      result: JSON.stringify({ is_error: true, result: 'OAuth session expired' }),
    })

    assert.equal(claudeResponseFailure(output)?.code, 'claude-auth-required')
    assert.throws(() => parseClaudeDayMemory(output), /claude-auth-required/)
  })

  it('identifies Claude structured-output failures for the plain JSON fallback', () => {
    const schemaFailure = JSON.stringify({
      is_error: true,
      result: "Output does not match required schema: root must have required property 'range'",
    })
    const retryFailure = JSON.stringify({
      is_error: true,
      subtype: 'error_max_structured_output_retries',
    })

    assert.equal(claudeResponseFailure(schemaFailure)?.code, 'claude-structured-output-failed')
    assert.deepEqual(claudeResponseFailure(schemaFailure), {
      code: 'claude-structured-output-failed',
      detail: "Output does not match required schema: root must have required property 'range'",
    })
    assert.equal(claudeResponseFailure(retryFailure)?.code, 'claude-structured-output-failed')
    assert.throws(() => parseClaudeDayMemory(schemaFailure), /claude-structured-output-failed/)
  })

  it('rejects unparseable output or an object without a summary', () => {
    assert.throws(
      () => parseDayMemory('not json'),
      (error) => {
        assert.ok(error instanceof Error)
        assert.match(agentErrorDetail(error, 'agent-invalid-response') ?? '', /not valid JSON.*objectCandidate=no/)
        return true
      }
    )
    assert.throws(
      () => parseDayMemory('{"outcomes":[]}'),
      (error) => {
        assert.ok(error instanceof Error)
        assert.match(
          agentErrorDetail(error, 'agent-invalid-response') ?? '',
          /recognized=outcomes.*summary was undefined/
        )
        return true
      }
    )
  })

  it('reports required shard fields without retaining response content', () => {
    assert.throws(
      () => parseClaudeShardAnalysis(JSON.stringify({ result: '{"summary":"private response content"}' })),
      (error) => {
        assert.ok(error instanceof Error)
        const detail = agentErrorDetail(error, 'agent-invalid-response') ?? ''
        assert.match(detail, /recognized=summary.*invalid or missing fields: range,facts/)
        assert.doesNotMatch(detail, /private response content/)
        return true
      }
    )
  })

  it('recovers a summary-only response with empty optional sections', () => {
    const memory = parseDayMemory('{"summary":"Day"}')
    assert.equal(memory.summary, 'Day')
    assert.deepEqual(memory.outcomes, [])
    assert.deepEqual(memory.timeline, [])
  })

  it('keeps a useful report when individual optional entries are malformed', () => {
    const value = JSON.parse(memoryJson)
    value.currentFocus = undefined
    value.decisions = undefined
    value.projectAttention = [{ project: 'Remember', durationMinutes: 45 }]
    value.conversations.push({ startTime: '15:00', endTime: '14:00', title: 'Bad interval', description: 'Ignore' })
    value.timeline.push({ startTime: '18:00', endTime: '18:00', title: 'Bad interval', description: 'Ignore' })

    const memory = parseDayMemory(JSON.stringify(value))

    assert.equal(memory.currentFocus, null)
    assert.deepEqual(memory.decisions, [])
    assert.deepEqual(memory.projectAttention, [{ project: 'Remember', durationMinutes: 45, description: '' }])
    assert.equal(
      memory.conversations.some((conversation) => conversation.title === 'Bad interval'),
      false
    )
    assert.equal(
      memory.timeline.some((block) => block.title === 'Bad interval'),
      false
    )
  })

  it('uses the short conversation description as a legacy summary fallback', () => {
    const value = JSON.parse(memoryJson)
    value.conversations[0].summary = undefined
    value.conversations[0].actionPoints = undefined

    const memory = parseDayMemory(JSON.stringify(value))

    assert.equal(memory.conversations[0]?.description, 'Agreed on Friday.')
    assert.equal(memory.conversations[0]?.summary, 'Agreed on Friday.')
    assert.deepEqual(memory.conversations[0]?.actionPoints, [])
  })

  it('keeps a useful report when Claude omits optional sections', () => {
    const memory = parseClaudeDayMemory(
      JSON.stringify({
        is_error: false,
        structured_output: {
          summary: 'A useful partial response.',
          outcomes: ['Completed the important fix'],
        },
      })
    )

    assert.equal(memory.summary, 'A useful partial response.')
    assert.deepEqual(memory.outcomes, ['Completed the important fix'])
    assert.deepEqual(memory.openTasks, [])
    assert.deepEqual(memory.timeline, [])
  })

  it('normalizes one-item lists and stringified object arrays from Claude', () => {
    const memory = parseClaudeDayMemory(
      JSON.stringify({
        result: JSON.stringify({
          summary: 'A useful response.',
          outcomes: 'Completed the important fix',
          openTasks:
            '[{"title":"Release","description":"Ship the hardened build.","source":{"kind":"task","label":"Release","detail":"Release work remains open.","evidenceId":"context-release"}}]',
        }),
      })
    )

    assert.deepEqual(memory.outcomes, ['Completed the important fix'])
    assert.deepEqual(memory.openTasks, [
      {
        title: 'Release',
        description: 'Ship the hardened build.',
        source: {
          kind: 'task',
          label: 'Release',
          detail: 'Release work remains open.',
          evidenceId: 'context-release',
        },
      },
    ])
  })

  it('preserves JSON-looking text inside a report list', () => {
    const shard = {
      range: '5 aug 2026, 10:32–10:44 CEST',
      facts: ['Observed payload {"status":"ready"}.'],
      activities: [],
      audioConversations: [],
      outcomes: [],
      decisions: [],
      actionPoints: [],
      openLoops: [],
    }

    assert.deepEqual(parseClaudeShardAnalysis(JSON.stringify({ result: JSON.stringify(shard) })), shard)
  })
})
