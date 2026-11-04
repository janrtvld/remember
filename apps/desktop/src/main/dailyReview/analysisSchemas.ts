import { GENERATED_TASK_DESCRIPTION_CHARACTER_LIMIT } from './workItemPrompt'

const GENERATED_WIKI_SLUG_PATTERN =
  '^(?:projects|decisions|research|people|processes|concepts)/[a-z0-9]+(?:-[a-z0-9]+)*(?:/[a-z0-9]+(?:-[a-z0-9]+)*)*$'

const WIKI_CONTENT_SCHEMA = {
  type: 'string',
  description:
    'Complete current Markdown body for the managed section. Preserve supported existing detail; do not truncate the page.',
}

export const FINAL_ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', maxLength: 800 },
    currentFocus: { type: ['string', 'null'], maxLength: 90 },
    outcomes: { type: 'array', maxItems: 4, items: { type: 'string', maxLength: 90 } },
    openTasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: ['string', 'null'], maxLength: 80 },
          titleChangeReason: {
            type: ['string', 'null'],
            enum: ['outcome', null],
            description:
              'Set outcome only when refining an existing generated substep title to its already established overall outcome. Use null for new tasks, cosmetic rewording, and user-edited titles.',
          },
          title: {
            type: 'string',
            maxLength: 90,
            description:
              'System-generated Inbox title: 2–5 words, target 32 characters, maximum 40. Preserve longer user-edited titles exactly.',
          },
          description: {
            type: 'string',
            maxLength: GENERATED_TASK_DESCRIPTION_CHARACTER_LIMIT,
            description:
              'The intended outcome and its supported remaining steps, in concise sentences or a short checklist. Keep related steps here instead of separate tasks; evidence belongs in context.',
          },
          prompt: { type: 'string', maxLength: 2400 },
          aiSuggestion: {
            type: ['string', 'null'],
            maxLength: 200,
            description:
              'One short optional offer for a concrete result AI can deliver, in the user language. Null for physical errands, meetings, personal decisions or other human actions. Never invent preparation work.',
          },
          context: { type: 'string', maxLength: 2400 },
          returnPoint: {
            type: 'object',
            properties: {
              lastMove: { type: 'string', maxLength: 240 },
              unresolved: { type: 'string', maxLength: 240 },
              nextMove: { type: 'string', maxLength: 240 },
            },
            required: ['lastMove', 'unresolved', 'nextMove'],
            additionalProperties: false,
          },
          source: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['conversation', 'task'] },
              label: { type: 'string', maxLength: 80 },
              detail: {
                type: 'string',
                maxLength: 52,
                description: 'Inbox list subtitle: 3–7 words, target 40 characters.',
              },
              conversationStartTime: {
                type: ['string', 'null'],
                pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$',
              },
              evidenceId: {
                type: ['string', 'null'],
                maxLength: 120,
                description: 'Exact screen evidence id for task sources; null for conversation sources.',
              },
            },
            required: ['kind', 'label', 'detail', 'conversationStartTime', 'evidenceId'],
            additionalProperties: false,
          },
        },
        required: [
          'id',
          'titleChangeReason',
          'title',
          'description',
          'prompt',
          'aiSuggestion',
          'context',
          'returnPoint',
          'source',
        ],
        additionalProperties: false,
      },
    },
    taskChanges: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string', maxLength: 80 },
          title: { type: 'string', maxLength: 90 },
          type: { type: 'string', enum: ['completed', 'removed', 'superseded'] },
          reason: { type: 'string', maxLength: 140 },
          replacementTitle: { type: ['string', 'null'], maxLength: 90 },
        },
        required: ['id', 'title', 'type', 'reason', 'replacementTitle'],
        additionalProperties: false,
      },
    },
    projectAttention: {
      type: 'array',
      maxItems: 5,
      items: {
        type: 'object',
        properties: {
          project: { type: 'string', maxLength: 60 },
          durationMinutes: { type: 'integer', minimum: 1 },
        },
        required: ['project', 'durationMinutes'],
        additionalProperties: false,
      },
    },
    conversations: {
      type: 'array',
      maxItems: 6,
      items: {
        type: 'object',
        properties: {
          startTime: { type: 'string', pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$' },
          endTime: { type: 'string', pattern: '^(?:(?:[01]\\d|2[0-3]):[0-5]\\d|24:00)$' },
          title: { type: 'string', maxLength: 90 },
          description: { type: 'string', maxLength: 180 },
          summary: { type: 'string', maxLength: 1_200 },
          actionPoints: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 140 } },
        },
        required: ['startTime', 'endTime', 'title', 'description', 'summary', 'actionPoints'],
        additionalProperties: false,
      },
    },
    knowledgeSuggestions: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        properties: {
          slug: {
            type: 'string',
            pattern: GENERATED_WIKI_SLUG_PATTERN,
          },
          title: { type: 'string', maxLength: 80 },
          content: {
            type: 'string',
            description:
              'For an existing page, describe only the specific proposed factual changes; a separate edit stage preserves the full current page. For a new page, provide the complete durable Markdown body.',
          },
          summary: { type: 'string', maxLength: 240 },
          changeType: { type: 'string', enum: ['created', 'updated'] },
          suggestedSpaceId: { type: ['string', 'null'], maxLength: 120 },
        },
        required: ['slug', 'title', 'content', 'summary', 'changeType', 'suggestedSpaceId'],
        additionalProperties: false,
      },
    },
    timeline: {
      type: 'array',
      maxItems: 12,
      items: {
        type: 'object',
        properties: {
          startTime: { type: 'string', pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$' },
          endTime: { type: 'string', pattern: '^(?:(?:[01]\\d|2[0-3]):[0-5]\\d|24:00)$' },
          title: { type: 'string', maxLength: 80 },
          description: { type: 'string', maxLength: 320 },
          details: {
            type: 'array',
            maxItems: 6,
            items: {
              type: 'object',
              properties: {
                at: { type: 'string', pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$' },
                text: { type: 'string', maxLength: 240 },
              },
              required: ['at', 'text'],
              additionalProperties: false,
            },
          },
        },
        required: ['startTime', 'endTime', 'title', 'description', 'details'],
        additionalProperties: false,
      },
    },
  },
  required: [
    'summary',
    'currentFocus',
    'outcomes',
    'openTasks',
    'taskChanges',
    'projectAttention',
    'conversations',
    'knowledgeSuggestions',
    'timeline',
  ],
  additionalProperties: false,
}

export const SHARD_ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    range: { type: 'string' },
    facts: { type: 'array', items: { type: 'string' } },
    activities: { type: 'array', items: { type: 'string' } },
    audioConversations: { type: 'array', items: { type: 'string' } },
    outcomes: { type: 'array', items: { type: 'string' } },
    decisions: { type: 'array', items: { type: 'string' } },
    actionPoints: { type: 'array', items: { type: 'string' } },
    openLoops: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'range',
    'facts',
    'activities',
    'audioConversations',
    'outcomes',
    'decisions',
    'actionPoints',
    'openLoops',
  ],
  additionalProperties: false,
}

export const CONTEXT_IMPORT_SCHEMA = {
  type: 'object',
  properties: {
    pages: {
      type: 'array',
      maxItems: 16,
      items: {
        type: 'object',
        properties: {
          slug: {
            type: 'string',
            pattern: GENERATED_WIKI_SLUG_PATTERN,
          },
          title: { type: 'string', maxLength: 80 },
          content: WIKI_CONTENT_SCHEMA,
          summary: { type: 'string', maxLength: 240 },
          changeType: { type: 'string', enum: ['created', 'updated'] },
        },
        required: ['slug', 'title', 'content', 'summary', 'changeType'],
        additionalProperties: false,
      },
    },
  },
  required: ['pages'],
  additionalProperties: false,
}

export const TIMELINE_WIKI_SCHEMA = {
  type: 'object',
  properties: {
    pages: {
      type: 'array',
      minItems: 1,
      maxItems: 1,
      items: CONTEXT_IMPORT_SCHEMA.properties.pages.items,
    },
  },
  required: ['pages'],
  additionalProperties: false,
}
