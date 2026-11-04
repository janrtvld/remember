import type { AssistantMessage, AssistantResult, RememberBridge, SendAssistantMessageInput } from '@remember/shared'

type AssistantBridge = Pick<
  RememberBridge,
  | 'getAssistantTaskActionsEnabled'
  | 'getAssistantConversation'
  | 'getAssistantTaskDraft'
  | 'controlAssistantTask'
  | 'sendAssistantMessage'
  | 'sendAssistantQueuedMessage'
  | 'retryAssistantMessage'
  | 'cancelAssistantTurn'
  | 'onAssistantChanged'
>

export function createBrowserAssistantBridge(projectDocuments?: () => Promise<AssistantResult[]>): AssistantBridge {
  const messages: AssistantMessage[] = []
  const submissions = new Map<string, string>()
  const listeners = new Set<() => void>()
  let timer: ReturnType<typeof setInterval> | null = null
  let active: AssistantMessage | null = null
  const changed = () => {
    for (const listener of listeners) listener()
  }
  const snapshot = (before?: string) => {
    const index = before ? messages.findIndex((message) => message.id === before) : messages.length
    if (index < 0) throw new Error('assistant-message-not-found')
    return {
      messages: structuredClone(messages.slice(Math.max(0, index - 40), index)),
      activeTurnId: active?.id ?? null,
      hasEarlier: index > 40,
      execution: 'local' as const,
      taskActionsEnabled: false,
    }
  }
  const start = async (input: SendAssistantMessageInput, retryOf?: AssistantMessage) => {
    if (!input.text.trim()) throw new Error('invalid-assistant-message')
    const clientId = input.clientMessageId
    const fingerprint = JSON.stringify([input.text.trim(), input.provider, input.mode ?? null, input.queue ?? false])
    if (clientId !== undefined) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientId))
        throw new Error('invalid-assistant-message')
      const previous = submissions.get(clientId)
      if (previous !== undefined) {
        if (previous !== fingerprint) throw new Error('assistant-message-id-conflict')
        return snapshot()
      }
    }
    if (active) throw new Error('assistant-already-running')
    const user = retryOf?.replyTo ? messages.find((entry) => entry.id === retryOf.replyTo) : null
    const userId = user?.id ?? clientId ?? crypto.randomUUID()
    const now = Date.now()
    if (!user)
      messages.push({
        id: userId,
        role: 'user',
        text: input.text.trim(),
        provider: input.provider,
        createdAt: now,
        updatedAt: now,
        status: 'completed',
        replyTo: null,
        error: null,
        steps: [],
      })
    const reply: AssistantMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      text: '',
      provider: input.provider,
      createdAt: now,
      updatedAt: now,
      status: 'streaming',
      replyTo: userId,
      error: null,
      steps: input.text.startsWith('qa-fidelity-format')
        ? [
            {
              id: 'format-summary',
              kind: 'reasoning',
              text: 'Organizing the observations into a table and a short example.',
              at: now,
            },
          ]
        : input.text.startsWith('qa-progress-status')
          ? [{ id: 'generic-command', kind: 'status', text: 'Uitvoeren: preview command', at: now }]
          : [],
    }
    if (input.text.startsWith('qa-proactive-card')) {
      reply.initiative = {
        kind: 'offer',
        decisionId: 'qa-contextual-offer',
        topicKey: 'qa-deployment-check',
        dismissed: false,
        taskIds: input.text.endsWith('task') ? ['browser-work-item-inbox'] : [],
        sources: [
          {
            id: 'qa-day-source',
            kind: 'day',
            dayId: `day/${new Date().toISOString().slice(0, 10)}`,
            quote: 'Automatische deployment vraagt nog een directe proef.',
            observedAt: now,
            appName: 'Remember',
            windowTitle: '',
          },
        ],
      }
    }
    messages.push(reply)
    if (clientId) submissions.set(clientId, fingerprint)
    active = reply
    const projectFixture = input.text.trim() === 'qa-project-documents' && projectDocuments
    if (projectFixture) {
      try {
        reply.results = await projectFixture()
      } catch (error) {
        if (active !== reply) return snapshot()
        reply.status = 'failed'
        reply.error = error instanceof Error ? error.message : 'browser-project-documents-unavailable'
        active = null
        changed()
        return snapshot()
      }
      if (active !== reply) return snapshot()
    }
    const response = projectFixture
      ? 'Ik heb [China](/wiki/page/?space=personal&slug=projects%2Fchina) aangemaakt met een eerste route en [Praktische voorbereiding](/wiki/page/?space=personal&slug=projects%2Fchina%2Fpractical-info). Reisdata en verblijfsduur staan nog open.'
      : input.text.startsWith('qa-proactive-card')
        ? 'Zal ik een korte checklist maken voor de directe proef van de automatische Cloudflare-deployment?'
        : input.text.startsWith('qa-reference-cards')
          ? 'Ik kan [de smalle Inbox controleren](/inbox/?item=browser-work-item-inbox). De aanpak staat in [Browser UI testing](/wiki/page/?space=personal&slug=processes%2Fbrowser-ui-testing).\n\nIk pak dit pas op als je dat wilt. [Dezelfde taak](/inbox/?item=browser-work-item-inbox) blijft één verwijzing. [Externe documentatie](https://example.com) blijft een gewone link.'
          : input.text.startsWith('qa-fidelity-format')
            ? '# Autumn observations\n\nCompare the leaves collected in the park. **Record the colours** before counting them.\n\n### What to record\n\n1. The tree species.\n2. The colour of each leaf.\n3. The date and weather.\n\n| Colour | Count |\n| --- | --- |\n| Green | 2 |\n| Yellow | 4 |\n| Red | 3 |\n\n```python\nleaves = ["green", "yellow", "red"]\nfor colour in leaves:\n    print(colour)\n```\n\nThe result is a simple colour inventory. [Learn about photosynthesis](https://en.wikipedia.org/wiki/Photosynthesis).'
            : 'Dit is een voorbeeldantwoord voor de browserpreview. In de Remember-app gebruikt dit gesprek je verbonden agent en actuele context. Hier wordt geen echt werk uitgevoerd.'
    let progressTick = 0
    timer = setInterval(() => {
      if (input.text.startsWith('qa-progress-updates') && progressTick++ < 60) {
        if (progressTick <= 15) return
        const phase = Math.floor((progressTick - 16) / 15)
        const summaries = [
          'Ik kijk welke bronnen deze vraag kunnen beantwoorden.',
          'Ik vergelijk de bevindingen en controleer waar ze verschillen.',
          'Ik werk de conclusie uit met de belangrijkste kanttekening.',
        ]
        reply.steps = [
          ...summaries.slice(0, phase + 1).map((text, index) => ({
            id: `progress-${index}`,
            kind: 'reasoning' as const,
            text,
            at: now + index * 2700,
          })),
          { id: 'generic-command', kind: 'status', text: 'Uitvoeren: preview command', at: Date.now() },
        ]
        changed()
        return
      }
      reply.text = response.slice(0, reply.text.length + 32)
      reply.updatedAt = Date.now()
      if (reply.text.length === response.length) {
        reply.status = 'completed'
        active = null
        if (timer) clearInterval(timer)
        timer = null
      }
      changed()
    }, 180)
    changed()
    return snapshot()
  }
  return {
    getAssistantTaskDraft: async () => {
      throw new Error('host-task-unavailable-in-browser-preview')
    },
    controlAssistantTask: async () => {
      throw new Error('host-task-unavailable-in-browser-preview')
    },
    getAssistantTaskActionsEnabled: async () => false,
    getAssistantConversation: async (before) => snapshot(before),
    sendAssistantMessage: async (input) => start(input),
    sendAssistantQueuedMessage: async () => {
      throw new Error('assistant-queue-unavailable-in-browser-preview')
    },
    retryAssistantMessage: async (id) => {
      const reply = messages.find((entry) => entry.id === id)
      const user = messages.find((entry) => entry.id === reply?.replyTo)
      if (!reply || !user || !['failed', 'cancelled', 'interrupted'].includes(reply.status))
        throw new Error('assistant-message-not-retryable')
      return start({ text: user.text, provider: reply.provider }, reply)
    },
    cancelAssistantTurn: async () => {
      if (timer) clearInterval(timer)
      timer = null
      if (active) active.status = 'cancelled'
      active = null
      changed()
    },
    onAssistantChanged: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
