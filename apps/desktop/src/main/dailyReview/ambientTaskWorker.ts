import type { WorkItem } from '@remember/shared'
import type { AmbientTaskPlan } from './ambientTaskPolicy'
import type { AmbientEvidence, AmbientEvidenceKind, AmbientTaskStore } from './ambientTaskStore'

export function createAmbientTaskAuthority() {
  let enabled = false
  let revision = 0
  return {
    update(next: boolean) {
      if (next !== enabled) revision++
      enabled = next
    },
    dayAnalysisToken() {
      return enabled ? null : revision
    },
    canApplyDayAnalysis(token: number | null) {
      return !enabled && token !== null && token === revision
    },
  }
}

export function createAmbientTaskWorker(options: {
  store: AmbientTaskStore
  policy: () => string | null
  allowed: (kind: AmbientEvidenceKind) => boolean
  accept: (evidence: AmbientEvidence) => boolean
  items: () => WorkItem[]
  analyze: (evidence: AmbientEvidence[], items: WorkItem[], signal: AbortSignal) => Promise<AmbientTaskPlan>
  apply: (evidence: AmbientEvidence[], plan: AmbientTaskPlan, startedAt: number) => void
  changed: () => void
  notify: (item: WorkItem) => void
  suggest?: (item: WorkItem, sources: AmbientEvidence[]) => boolean
  notificationsSupported: () => boolean
  error: (error: unknown) => void
  now?: () => number
}) {
  const now = options.now ?? Date.now
  let timer: ReturnType<typeof setInterval> | null = null
  let running: Promise<void> | null = null
  let controller: AbortController | null = null
  let activePolicy: string | null = null
  let retryAt = 0
  let stopped = false
  let needsBootstrap = true

  async function run() {
    const policy = options.policy()
    if (stopped || !policy) return
    if (options.suggest) {
      const id = options.store.nextSuggestion(now())
      if (id) {
        const item = options.items().find((entry) => entry.id === id && entry.lifecycle === 'open')
        const sources = item ? options.store.taskEvidence(id) : []
        const permitted =
          item && sources.length && sources.every((source) => options.allowed(source.kind) && options.accept(source))
        if (!permitted) options.store.suppressAttention(id, now())
        else if (options.suggest(item, sources)) options.store.acknowledgeSuggestion(id, now())
      }
    }
    if (options.notificationsSupported()) {
      const id = options.store.nextNotification(now())
      const item = id ? options.items().find((entry) => entry.id === id && entry.lifecycle === 'open') : null
      const sources = item ? options.store.taskEvidence(item.id) : []
      if (item && sources.length && sources.every((source) => options.allowed(source.kind) && options.accept(source))) {
        if (options.store.takeNotification(now(), item.id) === item.id) options.notify(item)
      } else if (id) options.store.suppressAttention(id, now())
    }
    if (now() < retryAt) return
    if (needsBootstrap) needsBootstrap = options.store.bootstrap(now()) === 200
    const evidence = options.store.batch(now(), options.allowed, options.accept)
    if (!evidence.length) return
    const startedAt = now()
    activePolicy = policy
    controller = new AbortController()
    const items = options.items()
    const plan = await options.analyze(evidence, items, controller.signal)
    const currentItems = new Set(options.items().map((item) => item.id))
    if (
      stopped ||
      controller.signal.aborted ||
      options.policy() !== policy ||
      items.some((item) => !currentItems.has(item.id)) ||
      evidence.some((entry) => !options.allowed(entry.kind) || !options.accept(entry) || !options.store.resolve(entry))
    )
      return
    options.apply(evidence, plan, startedAt)
    options.changed()
  }

  function tick() {
    if (stopped) return Promise.resolve()
    if (running) {
      if (options.policy() !== activePolicy) controller?.abort()
      return running
    }
    running = run()
      .catch((error) => {
        if (!controller?.signal.aborted && !stopped) {
          retryAt = now() + 30_000
          options.error(error)
        }
      })
      .finally(() => {
        controller = null
        activePolicy = null
        running = null
      })
    return running
  }

  return {
    tick,
    start() {
      stopped = false
      timer ??= setInterval(() => void tick(), 1_000)
      timer.unref?.()
      void tick()
    },
    async stop() {
      stopped = true
      if (timer) clearInterval(timer)
      timer = null
      controller?.abort()
      await running
    },
  }
}
