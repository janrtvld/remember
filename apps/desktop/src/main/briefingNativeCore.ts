import { createHash, randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import { type AssistantConversation, redactSensitiveCaptureText, type WikiPage } from '@remember/shared'
import {
  canonicalBriefingJson as canonical,
  hashBriefingValue as hash,
} from '../../../../experiments/always-on-agent/briefing-protocol.mjs'
import type { AgentContextSnapshot } from './agentContextService'
import { createBriefingActionService } from './briefingActionService'
import type { BriefingConnection } from './briefingTcpConnector'
import type { EvidenceStore } from './dailyReview/evidenceStore'
import type { ProactiveDecision, ProactiveSource, ProactiveSourceRef } from './dailyReview/proactiveStore'
import {
  buildInitiativePrepared,
  type HostInitiativeEnvelopeV2,
  type InitiativeScreenApp,
  type StandingGrantScope,
  validateInitiativeScreenApp,
  validateStandingGrantScope,
} from './hostInitiativeProtocol'
import type { InitiativeAction, StandingGrant } from './hostInitiativeStore'
import type { ResidentAgentStore } from './residentAgentStore'
import type { BriefingReplyReference } from './residentReplyContext'

export type BriefingChatEntry = {
  reference: BriefingReplyReference
  content: string
  sources: Record<string, unknown>[]
}

type BriefingNativeManifestCommon = {
  profilePath: string
  installationId: string
  targetId: string
  targetEpoch: string
  root: string
  computerExecutionKey: string
  targetLabel: string
  source: { spaceId: 'personal'; slug: string }
  model: string
  effort: string
  maxDurationMs: number
  slots: { jobId: string; endpoint: string; directory: string; workspace: string }[]
}
export type BriefingNativeManifest = BriefingNativeManifestCommon &
  ({ version: 1; evidenceSourceIds: string[] } | { version: 2; screenApp: InitiativeScreenApp })
export type BriefingNativeContext = {
  available: boolean
  fingerprint: string
  policyToken: string | null
  profilePath: string
  installationId: string
  computerExecutionKey: string
  locale: 'nl' | 'en'
  timeZone: string
}
export type BriefingNativeDependencies = {
  manifest: BriefingNativeManifest
  resident: ResidentAgentStore
  evidence: Pick<EvidenceStore, 'proactive' | 'deletionRevision'>
  context(): BriefingNativeContext
  currentPage(): WikiPage | null
  readPersonal(signal: AbortSignal): Promise<AgentContextSnapshot>
  projectEvidence(source: ProactiveSource): ProactiveSource | null
  projectPersonal(page: WikiPage): string
  attentionAvailable(): boolean
  connect(endpoint: string, action: InitiativeAction): Promise<BriefingConnection>
  systemPrompt: string
  changed(): void
  error(error: unknown): void
  now?: () => number
}

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b)
const digest = (text: string) => createHash('sha256').update(text).digest('hex')
function exact(input: unknown, keys: string[]): Record<string, unknown> {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(input, key))
  )
    throw new Error('briefing-input-invalid')
  return input as Record<string, unknown>
}
function identity(value: unknown, max = 300): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > max ||
    [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  )
    throw new Error('briefing-input-invalid')
}
function absolute(value: unknown): asserts value is string {
  identity(value, 2000)
  if (
    !value.startsWith('/') ||
    value === '/' ||
    value.endsWith('/') ||
    value.includes('\\') ||
    posix.normalize(value) !== value
  )
    throw new Error('briefing-input-invalid')
}
export function briefingQaInstallationId(profilePath: string) {
  absolute(profilePath)
  return digest(`remember-briefing-qa-v1\0${profilePath}`)
}
export function selectBriefingNativeResources(input: {
  isPackaged: boolean
  qaEnabled: boolean
  qaManifestPath?: string
}) {
  if (input.isPackaged || !input.qaEnabled) throw new Error('briefing-disabled')
  const manifestPath = input.qaManifestPath
  if (!manifestPath) throw new Error('briefing-manifest-required')
  absolute(manifestPath)
  return { manifestPath, version: 1 as const, promptBasename: 'prompt.v1.txt' }
}
export function validateBriefingNativeManifest(input: unknown): BriefingNativeManifest {
  const version = (input as { version?: unknown } | null)?.version
  const value = exact(input, [
    'version',
    'profilePath',
    'installationId',
    'targetId',
    'targetEpoch',
    'root',
    'computerExecutionKey',
    'targetLabel',
    'source',
    version === 2 ? 'screenApp' : 'evidenceSourceIds',
    'model',
    'effort',
    'maxDurationMs',
    'slots',
  ])
  if (value.version !== 1 && value.version !== 2) throw new Error('briefing-manifest-invalid')
  absolute(value.profilePath)
  absolute(value.root)
  for (const key of ['installationId', 'targetId', 'targetEpoch', 'targetLabel', 'model', 'effort'])
    identity(value[key])
  identity(value.computerExecutionKey, 4000)
  if (
    !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(String(value.effort)) ||
    !Number.isSafeInteger(value.maxDurationMs) ||
    Number(value.maxDurationMs) < 5000 ||
    Number(value.maxDurationMs) > 120000
  )
    throw new Error('briefing-manifest-invalid')
  const source = exact(value.source, ['spaceId', 'slug'])
  identity(source.slug)
  if (
    source.spaceId !== 'personal' ||
    !/^[a-z0-9]+(?:[a-z0-9/-]*[a-z0-9])?$/.test(source.slug) ||
    ['index', 'log'].includes(source.slug) ||
    source.slug.split('/').some((part) => !part)
  )
    throw new Error('briefing-manifest-invalid')
  if (value.version === 2) validateInitiativeScreenApp(value.screenApp)
  else {
    if (
      !Array.isArray(value.evidenceSourceIds) ||
      !value.evidenceSourceIds.length ||
      value.evidenceSourceIds.length > 12 ||
      new Set(value.evidenceSourceIds).size !== value.evidenceSourceIds.length
    )
      throw new Error('briefing-manifest-invalid')
    value.evidenceSourceIds.forEach((id) => {
      identity(id, 500)
    })
  }
  if (!Array.isArray(value.slots) || value.slots.length !== 2) throw new Error('briefing-manifest-invalid')
  const jobs = new Set(),
    endpoints = new Set()
  for (const inputSlot of value.slots) {
    const slot = exact(inputSlot, ['jobId', 'endpoint', 'directory', 'workspace'])
    identity(slot.jobId)
    identity(slot.endpoint)
    const match = /^tcp:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.exec(slot.endpoint)
    const directory = `${value.root}/jobs/${digest(slot.jobId).slice(0, 24)}`
    if (
      !match ||
      Number(match[1]) > 65535 ||
      jobs.has(slot.jobId) ||
      endpoints.has(slot.endpoint) ||
      slot.directory !== directory ||
      slot.workspace !== `${directory}/workspace`
    )
      throw new Error('briefing-manifest-invalid')
    jobs.add(slot.jobId)
    endpoints.add(slot.endpoint)
  }
  return structuredClone(input as BriefingNativeManifest)
}

export function createBriefingNative(options: BriefingNativeDependencies) {
  const manifest = validateBriefingNativeManifest(options.manifest)
  const now = options.now ?? Date.now
  const store = options.resident.initiatives
  const lifetime = new AbortController()
  let disposed = false
  let preparing = false
  let invalidationEpoch = 0
  let pausedThroughGeneration = 0
  const revokedGenerations = new Map<string, number>()
  const assertEpoch = (epoch: number) => {
    if (epoch !== invalidationEpoch) throw new Error('briefing-context-invalidated')
  }
  const previews = new Map<string, { scope: StandingGrantScope; pageTitle: string; createdAt: number; epoch: number }>()
  const grantId = `briefing:${digest(canonical([manifest.profilePath, manifest.installationId, manifest.targetId])).slice(0, 32)}`
  function available() {
    if (disposed || lifetime.signal.aborted) throw new Error('briefing-disposed')
    const context = structuredClone(options.context())
    if (
      !context.available ||
      context.profilePath !== manifest.profilePath ||
      context.installationId !== manifest.installationId ||
      context.computerExecutionKey !== manifest.computerExecutionKey
    )
      throw new Error('briefing-context-unavailable')
    return context
  }
  function page() {
    const value = options.currentPage()
    if (!value || value.slug !== manifest.source.slug || !value.revision) throw new Error('briefing-source-invalidated')
    return structuredClone(value)
  }
  function assertGrantContext(grant: StandingGrant) {
    const context = available()
    if (
      grant.id !== grantId ||
      grant.generation <= (revokedGenerations.get(grant.id) ?? -1) ||
      now() < grant.issuedAt ||
      grant.scope.contextFingerprint !== context.fingerprint ||
      grant.scope.version !== manifest.version ||
      (grant.scope.version === 2 && manifest.version === 2 && !same(grant.scope.screenApp, manifest.screenApp)) ||
      grant.scope.installationId !== context.installationId ||
      !same(grant.scope.target, { targetId: manifest.targetId, targetEpoch: manifest.targetEpoch, root: manifest.root })
    )
      throw new Error('briefing-grant-unavailable')
    const currentPage = page()
    if (
      !same(grant.scope.personalSources, [
        { spaceId: 'personal', slug: currentPage.slug, revision: currentPage.revision },
      ])
    )
      throw new Error('briefing-source-invalidated')
    if (available().fingerprint !== context.fingerprint) throw new Error('briefing-context-changed')
  }
  function activeGrant(needBudget: boolean) {
    const grant = store.grant(grantId)
    if (
      !grant ||
      !grant.enabled ||
      grant.generation <= pausedThroughGeneration ||
      grant.scope.expiresAt <= now() ||
      (needBudget && grant.remainingJobs < 1)
    )
      throw new Error('briefing-grant-unavailable')
    assertGrantContext(grant)
    return grant
  }
  async function freshPage(signal: AbortSignal) {
    const controller = new AbortController()
    const combined = AbortSignal.any([signal, lifetime.signal, controller.signal])
    const snapshot = await new Promise<AgentContextSnapshot>((resolve, reject) => {
      let settled = false
      const finish = (error: unknown, value?: AgentContextSnapshot) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        combined.removeEventListener('abort', abort)
        if (error) reject(error)
        else resolve(value!)
      }
      const abort = () => finish(new Error('briefing-operation-aborted'))
      const timer = setTimeout(() => {
        finish(new Error('briefing-source-unavailable'))
        controller.abort()
      }, 2000)
      combined.addEventListener('abort', abort, { once: true })
      if (combined.aborted) {
        abort()
        return
      }
      try {
        options.readPersonal(combined).then((value) => finish(null, value), finish)
      } catch (error) {
        finish(error)
      }
    })
    available()
    if (signal.aborted || combined.aborted) throw new Error('briefing-operation-aborted')
    if (snapshot.state !== 'fresh') throw new Error('briefing-source-unavailable')
    const current = page(),
      read = snapshot.pages.find((entry) => entry.slug === current.slug)
    if (!read || read.revision !== current.revision || read.content !== current.content)
      throw new Error('briefing-source-invalidated')
    return current
  }
  function sourceAllowed(ref: ProactiveSourceRef) {
    return manifest.version === 1
      ? manifest.evidenceSourceIds.includes(ref.evidenceId)
      : ref.kind === 'context' && ref.bundleId === manifest.screenApp.bundleId
  }
  function resolveSource(ref: ProactiveSourceRef, fresh: boolean) {
    if (!sourceAllowed(ref)) throw new Error('briefing-source-outside-grant')
    const source = options.evidence.proactive.resolve(ref)
    if (
      !source ||
      !sourceAllowed(source) ||
      Object.keys(ref).some((key) => !same(ref[key as keyof typeof ref], source[key as keyof ProactiveSource])) ||
      source.provenance.mediaPlayback === 'recorded' ||
      (fresh && (source.observedAt > now() || now() - source.observedAt > 120000))
    )
      throw new Error('briefing-source-invalidated')
    const projected = options.projectEvidence(source)
    if (!projected || projected.evidenceId !== source.evidenceId || !projected.text.trim())
      throw new Error('briefing-source-invalidated')
    return { source, projected }
  }
  function sources(decision: ProactiveDecision, fresh: boolean) {
    if (!decision.sourceRefs.length || decision.sourceRefs.length > (manifest.version === 2 ? 11 : 12))
      throw new Error('briefing-source-outside-grant')
    return decision.sourceRefs.map((ref) => resolveSource(ref, fresh))
  }
  function currentDecision(input: ProactiveDecision, messageId: string, fresh: boolean) {
    const value = options.evidence.proactive.get(input.id)
    if (
      !value ||
      !same(value, input) ||
      value.kind !== 'prepare' ||
      value.deliveredMessageId !== messageId ||
      value.invalidatedAt !== null ||
      value.consumerGeneration !== options.evidence.proactive.generation() ||
      value.deletionRevision !== options.evidence.deletionRevision() ||
      (fresh &&
        (value.createdAt > now() ||
          value.expiresAt <= now() ||
          value.conversationGeneration !== options.resident.proactiveConversationGeneration() ||
          value.policyToken !== available().policyToken))
    )
      throw new Error('briefing-decision-conflict')
    return value
  }
  function assertAction(action: InitiativeAction, stage: 'dispatch' | 'write' | 'publication' | 'historical') {
    if (
      stage === 'historical' &&
      (action.state !== 'completed' ||
        action.terminal?.phase !== 'completed' ||
        action.publication !== 'published' ||
        (action.terminal.completion !== 'silent' && !action.result))
    )
      throw new Error('briefing-result-unavailable')
    const grant = stage === 'historical' ? action.grant : activeGrant(false)
    assertGrantContext(grant)
    if (
      action.invalidated ||
      action.envelope.authority.grantId !== grant.id ||
      action.envelope.authority.grantGeneration !== grant.generation ||
      action.envelope.authority.grantScopeHash !== grant.scopeHash ||
      !same(action.envelope.target, grant.scope.target) ||
      !same(action.envelope.sourceRefs.personal, grant.scope.personalSources) ||
      action.envelope.deletionRevision !== options.evidence.deletionRevision()
    )
      throw new Error('briefing-action-invalidated')
    if (
      (stage === 'dispatch' || stage === 'write') &&
      (action.envelope.deadlineAt <= now() || !options.attentionAvailable())
    )
      throw new Error('briefing-action-unavailable')
    if (stage === 'write' && (grant.scope.expiresAt - now() < 3000 || action.envelope.deadlineAt - now() < 3000))
      throw new Error('briefing-write-window-insufficient')
    const decision = options.evidence.proactive.get(action.envelope.authority.decisionId)
    if (
      !decision ||
      decision.invalidatedAt !== null ||
      decision.inputHash !== action.envelope.authority.decisionInputHash ||
      decision.deliveredMessageId !== action.envelope.assistantMessageId
    )
      throw new Error('briefing-decision-conflict')
    const resolved = sources(decision, false),
      packet = JSON.parse(action.envelope.preparedInput.prompt) as { sources: { sourceId: string; revision: string }[] }
    for (const { source, projected } of resolved)
      if (
        !packet.sources.some(
          (entry) => entry.sourceId === source.evidenceId && entry.revision === digest(projected.text)
        )
      )
        throw new Error('briefing-source-invalidated')
    if (
      !packet.sources.some(
        (entry) =>
          entry.sourceId === `personal:${manifest.source.slug}` &&
          entry.revision === digest(options.projectPersonal(page()))
      )
    )
      throw new Error('briefing-source-invalidated')
    if (available().fingerprint !== grant.scope.contextFingerprint) throw new Error('briefing-context-changed')
  }
  const service = createBriefingActionService({
    store,
    now,
    changed: options.changed,
    error: options.error,
    assertCurrent: assertAction,
    connect: async (action) => {
      const descriptor = action.prepared.descriptor
      const slot = manifest.slots.find((s) => s.jobId === descriptor.jobId)
      if (
        !slot ||
        descriptor.targetId !== manifest.targetId ||
        descriptor.targetEpoch !== manifest.targetEpoch ||
        descriptor.root !== manifest.root ||
        descriptor.directory !== slot.directory ||
        descriptor.workspace !== slot.workspace
      )
        throw new Error('briefing-endpoint-binding-mismatch')
      return options.connect(slot.endpoint, action)
    },
    validateSources: async (action, signal) => {
      try {
        await freshPage(signal)
        assertAction(action, 'publication')
        return 'valid'
      } catch (error) {
        if (error instanceof Error && error.message === 'briefing-source-unavailable') return 'unavailable'
        if (signal.aborted || disposed) throw error
        return 'invalidated'
      }
    },
  })
  const exactAction = (input: unknown, keys: string[]) => {
    const value = exact(input, keys)
    identity(value.actionId)
    identity(value.messageId)
    const action = store.action(value.actionId)
    if (
      !action ||
      action.envelope.assistantMessageId !== value.messageId ||
      action.envelope.authority.grantId !== grantId ||
      !same(action.envelope.target, {
        targetId: manifest.targetId,
        targetEpoch: manifest.targetEpoch,
        root: manifest.root,
      })
    )
      throw new Error('briefing-binding-conflict')
    return { value, action }
  }
  function replyAction(input: unknown) {
    const { value, action } = exactAction(input, ['actionId', 'messageId', 'resultId', 'resultHash'])
    identity(value.resultId)
    if (typeof value.resultHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.resultHash))
      throw new Error('briefing-input-invalid')
    assertAction(action, 'historical')
    if (
      !action.result ||
      action.result.receipt.resultId !== value.resultId ||
      action.resultHash !== value.resultHash ||
      hash(action.result) !== action.resultHash
    )
      throw new Error('briefing-result-unavailable')
    return action
  }
  function assertReplyReferences(references: BriefingReplyReference[]) {
    if (!Array.isArray(references) || references.length > 3) throw new Error('briefing-input-invalid')
    const seen = new Set<string>()
    for (const reference of references) {
      const action = replyAction(reference)
      if (seen.has(action.envelope.actionId)) throw new Error('briefing-input-invalid')
      seen.add(action.envelope.actionId)
    }
  }
  async function prepareChatContext() {
    const epoch = invalidationEpoch
    assertEpoch(epoch)
    const briefings: BriefingChatEntry[] = []
    const candidates = store
      .all()
      .filter((action) => action.state === 'completed' && action.publication === 'published' && action.result)
      .sort((a, b) => (b.terminalReceivedAt ?? 0) - (a.terminalReceivedAt ?? 0))

    for (const candidate of candidates) {
      if (briefings.length === 3) break
      const reference: BriefingReplyReference = {
        actionId: candidate.envelope.actionId,
        messageId: candidate.envelope.assistantMessageId,
        resultId: candidate.result!.receipt.resultId,
        resultHash: candidate.resultHash!,
      }
      let entry: BriefingChatEntry
      try {
        const action = replyAction(reference)
        const packet = JSON.parse(action.envelope.preparedInput.prompt)
        if (
          hash(packet) !== action.envelope.sourcePacketHash ||
          !Array.isArray(packet.sources) ||
          packet.sources.some((source: unknown) => !source || typeof source !== 'object' || Array.isArray(source))
        )
          throw new Error('briefing-source-invalidated')
        entry = { reference, content: action.result!.content, sources: packet.sources }
      } catch {
        continue
      }
      const serialized = JSON.stringify([...briefings, entry])
      if (serialized.length <= 48000 && Buffer.byteLength(serialized, 'utf8') <= 48000) briefings.push(entry)
    }

    const references = briefings.map((entry) => structuredClone(entry.reference))
    if (references.length) {
      try {
        await freshPage(lifetime.signal)
      } catch (error) {
        assertEpoch(epoch)
        assertReplyReferences(references)
        if (!(error instanceof Error) || error.message !== 'briefing-source-unavailable') throw error
        references.length = 0
        briefings.length = 0
      }
    }
    assertEpoch(epoch)
    assertReplyReferences(references)
    const capturedReferences = structuredClone(references)
    return {
      briefings,
      references,
      assertCurrent: () => {
        assertEpoch(epoch)
        assertReplyReferences(capturedReferences)
      },
    }
  }
  async function disableGrant(privacy: boolean) {
    invalidationEpoch += 1
    previews.clear()
    const grant = store.grant(grantId)
    if (grant) {
      if (privacy) revokedGenerations.set(grant.id, grant.generation)
      else pausedThroughGeneration = Math.max(pausedThroughGeneration, grant.generation)
    }
    const actions = store.unresolved().filter((action) => action.envelope.authority.grantId === grantId)
    let failure: unknown
    try {
      if (grant) {
        if (privacy) store.revokeGrant(grantId, grant.generation, now())
        else store.pauseGrant(grantId, grant.generation, now())
      }
      for (const action of actions) if (!action.invalidated) store.invalidate(action.envelope.actionId)
    } catch (error) {
      failure = error
    }
    options.changed()
    for (const action of actions) await service.stop(action.envelope.actionId).catch(options.error)
    if (failure) throw failure
  }
  const bridge = {
    prepareChatContext,
    assertReplyReferences,
    async previewGrant() {
      const epoch = invalidationEpoch,
        context = available(),
        current = await freshPage(lifetime.signal)
      assertEpoch(epoch)
      if (available().fingerprint !== context.fingerprint) throw new Error('briefing-context-changed')
      const scope = validateStandingGrantScope({
        ...(manifest.version === 1
          ? {
              version: 1,
              evidenceSourceIds: manifest.evidenceSourceIds.map((id) => (id.startsWith('speech:') ? id.slice(7) : id)),
            }
          : { version: 2, screenApp: manifest.screenApp }),
        installationId: manifest.installationId,
        contextFingerprint: context.fingerprint,
        target: { targetId: manifest.targetId, targetEpoch: manifest.targetEpoch, root: manifest.root },
        capability: 'private-briefing-v1',
        afterSequence: options.evidence.proactive.latestSequence(),
        personalSources: [{ spaceId: 'personal', slug: current.slug, revision: current.revision }],
        model: manifest.model,
        effort: manifest.effort,
        maxInputBytes: 48000,
        maxOutputBytes: 16384,
        maxDurationMs: manifest.maxDurationMs,
        outputBasename: 'briefing.md',
        expiresAt: now() + 30 * 60000,
        maxJobs: 2,
      })
      const token = randomUUID()
      previews.clear()
      previews.set(token, { scope, pageTitle: current.title, createdAt: now(), epoch })
      return {
        token,
        targetLabel: manifest.targetLabel,
        projectLabel: current.title,
        sourceTitle: current.title,
        sourceSlug: current.slug,
        ...(manifest.version === 2 ? { screenAppLabel: manifest.screenApp.label } : {}),
        expiresAt: scope.expiresAt,
        maxJobs: 2 as const,
      }
    },
    async confirmGrant(token: unknown) {
      identity(token)
      const preview = previews.get(token)
      previews.delete(token)
      if (!preview || now() < preview.createdAt || now() - preview.createdAt > 60000)
        throw new Error('briefing-preview-expired')
      assertEpoch(preview.epoch)
      const context = available()
      if (context.fingerprint !== preview.scope.contextFingerprint) throw new Error('briefing-context-changed')
      const current = await freshPage(lifetime.signal)
      assertEpoch(preview.epoch)
      if (
        available().fingerprint !== preview.scope.contextFingerprint ||
        current.revision !== preview.scope.personalSources[0]?.revision
      )
        throw new Error('briefing-context-changed')
      if (store.unresolved().length) throw new Error('briefing-effect-slot-occupied')
      const scope = { ...preview.scope, afterSequence: options.evidence.proactive.latestSequence() }
      const grant = store.createGrant(scope, now(), grantId)
      options.changed()
      return grant
    },
    async revokeGrant(id: unknown) {
      identity(id)
      if (id !== grantId) throw new Error('briefing-grant-conflict')
      const grant = store.grant(id)
      if (!grant) throw new Error('briefing-grant-conflict')
      await disableGrant(false)
    },
    candidateSourceIds(selected: ProactiveSource[] = []) {
      try {
        const grant = activeGrant(true)
        if (manifest.version === 1) return [...manifest.evidenceSourceIds]
        const ids = new Set<string>()
        for (const input of selected) {
          try {
            const { source } = resolveSource(input, true)
            if (source.sequence > grant.scope.afterSequence && source.observedAt >= grant.issuedAt)
              ids.add(source.evidenceId)
          } catch {}
          if (ids.size === 11) break
        }
        assertGrantContext(grant)
        return [...ids]
      } catch {
        return []
      }
    },
    async consider(input: ProactiveDecision, messageId: string): Promise<string | null> {
      const decision = structuredClone(input)
      const prior = store.forMessage(messageId)
      if (prior) {
        const { deliveredMessageId: _m, invalidatedAt: _i, ...payload } = decision
        if (
          prior.envelope.authority.decisionId !== decision.id ||
          prior.envelope.authority.decisionPayloadHash !== hash(payload)
        )
          throw new Error('briefing-decision-conflict')
        return prior.envelope.actionId
      }
      if (preparing) throw new Error('briefing-preparation-busy')
      preparing = true
      try {
        const epoch = invalidationEpoch,
          context = available(),
          grant = activeGrant(true)
        currentDecision(decision, messageId, true)
        if (!options.attentionAvailable()) throw new Error('briefing-attention-unavailable')
        sources(decision, true)
        const current = await freshPage(lifetime.signal)
        assertEpoch(epoch)
        currentDecision(decision, messageId, true)
        const freshGrant = activeGrant(true)
        if (
          !same(freshGrant, grant) ||
          available().fingerprint !== context.fingerprint ||
          !options.attentionAvailable()
        )
          throw new Error('briefing-context-changed')
        const resolved = sources(decision, true)
        if (
          resolved.some(
            ({ source }) =>
              source.sequence <= grant.scope.afterSequence ||
              (manifest.version === 2 && source.observedAt < grant.issuedAt)
          )
        )
          throw new Error('briefing-source-before-grant')
        const slot = manifest.slots.find((s) => !store.ownsJob(s.jobId))
        if (!slot) throw new Error('briefing-slots-exhausted')
        const trigger = resolved.reduce((best, item) =>
          item.source.observedAt > best.source.observedAt ? item : best
        ).source
        const startedAt = now(),
          timeZone = context.timeZone
        const packet = {
          ...(manifest.version === 1
            ? { version: 1, synthetic: true }
            : { version: 2, material: 'canonical-source-snapshot' }),
          language: context.locale,
          clock: {
            utc: new Date(startedAt).toISOString(),
            local: new Intl.DateTimeFormat(context.locale === 'nl' ? 'nl-NL' : 'en-GB', {
              timeZone,
              dateStyle: 'full',
              timeStyle: 'long',
              hour12: false,
            }).format(startedAt),
            timeZone,
          },
          projectLabel: redactSensitiveCaptureText(current.title),
          trigger: {
            sourceId: trigger.evidenceId,
            observedAt: new Date(trigger.observedAt).toISOString(),
            acceptedAt: new Date(trigger.acceptedAt).toISOString(),
            ageMs: startedAt - trigger.observedAt,
            freshness: 'fresh',
          },
          sources: [
            ...resolved.map(({ source, projected }) => ({
              sourceId: source.evidenceId,
              revision: digest(projected.text),
              ...(manifest.version === 2
                ? {
                    bundleId: source.bundleId,
                    sourceRevision: source.revision,
                    eventRevision: source.eventRevision,
                    contentKey: source.contentKey,
                  }
                : {}),
              kind: source.kind,
              current: true,
              observedAt: new Date(source.observedAt).toISOString(),
              acceptedAt: new Date(source.acceptedAt).toISOString(),
              provenance: { origin: 'existing-evidence', ...source.provenance, causedByActionId: null },
              text: projected.text,
            })),
            {
              sourceId: `personal:${current.slug}`,
              revision: digest(options.projectPersonal(current)),
              kind: 'personal-page',
              current: true,
              observedAt: new Date(current.updatedAt).toISOString(),
              acceptedAt: new Date(startedAt).toISOString(),
              provenance: {
                origin: 'existing-personal-page',
                speaker: 'unknown',
                mediaPlayback: 'unknown',
                causedByActionId: null,
              },
              text: options.projectPersonal(current),
            },
          ],
          candidate: { kind: 'private-briefing', sourceIds: decision.sourceIds },
        }
        const { deliveredMessageId: _m, invalidatedAt: _i, ...payload } = decision
        const envelope: HostInitiativeEnvelopeV2 = {
          version: 2,
          authority: {
            kind: 'initiative',
            decisionId: decision.id,
            decisionInputHash: decision.inputHash,
            decisionPayloadHash: hash(payload),
            grantId: grant.id,
            grantGeneration: grant.generation,
            grantScopeHash: grant.scopeHash,
          },
          actionId: randomUUID(),
          jobId: slot.jobId,
          assistantMessageId: messageId,
          target: grant.scope.target,
          policyFingerprint: decision.policyToken,
          deletionRevision: decision.deletionRevision,
          sourceRefs: { evidence: decision.sourceRefs, personal: grant.scope.personalSources },
          sourcePacketHash: hash(packet),
          startedAt,
          deadlineAt: Math.min(startedAt + manifest.maxDurationMs, grant.scope.expiresAt),
          capability: 'private-briefing-v1',
          preparedInput: {
            prompt: JSON.stringify(packet, null, 2) + '\n',
            systemPrompt: options.systemPrompt,
            model: grant.scope.model,
            effort: grant.scope.effort,
            threadId: null,
            tools: [],
            maxInputBytes: grant.scope.maxInputBytes,
            maxOutputBytes: grant.scope.maxOutputBytes,
            maxDurationMs: grant.scope.maxDurationMs,
          },
        }
        const prepared = buildInitiativePrepared(envelope)
        if (prepared.descriptor.directory !== slot.directory || prepared.descriptor.workspace !== slot.workspace)
          throw new Error('briefing-endpoint-binding-mismatch')
        currentDecision(decision, messageId, true)
        activeGrant(true)
        if (!options.attentionAvailable() || available().fingerprint !== context.fingerprint)
          throw new Error('briefing-context-changed')
        assertEpoch(epoch)
        const admitted = store.admit(
          envelope,
          prepared,
          {
            decision,
            sourceSequences: resolved.map(({ source }) => ({ eventId: source.eventId, sequence: source.sequence })),
          },
          now()
        )
        options.changed()
        void service.startAdmitted(admitted.envelope.actionId).catch(options.error)
        return admitted.envelope.actionId
      } finally {
        preparing = false
      }
    },
    enrichSnapshot(conversation: AssistantConversation): AssistantConversation {
      let grant: StandingGrant | null = null
      try {
        grant = activeGrant(false)
      } catch {}
      return {
        ...conversation,
        briefingsEnabled: true,
        briefingGrant: grant
          ? {
              id: grant.id,
              expiresAt: grant.scope.expiresAt,
              remainingJobs: grant.remainingJobs,
              targetLabel: manifest.targetLabel,
            }
          : null,
        messages: conversation.messages.map((message) => {
          const action = store.forMessage(message.id)
          if (!action || action.envelope.authority.grantId !== grantId) return message
          let readable = false
          try {
            assertAction(action, action.state === 'completed' ? 'historical' : 'publication')
            readable = true
          } catch {}
          const state =
            action.state === 'prepared'
              ? 'prepared'
              : action.state === 'cancelled-unsubmitted'
                ? 'cancelled'
                : action.state === 'unknown' || action.state === 'dispatch-intent'
                  ? 'unknown'
                  : action.publication === 'withheld' || (action.state === 'completed' && !readable)
                    ? 'withheld'
                    : action.state === 'completed'
                      ? 'completed'
                      : action.state === 'stopped'
                        ? 'stopped'
                        : !service.isActive(action.envelope.actionId)
                          ? 'unknown'
                          : action.state === 'awaiting-write-permission'
                            ? 'waiting'
                            : 'running'
          const allowedControls: ('check' | 'stop' | 'cancel')[] =
            state === 'prepared'
              ? ['cancel']
              : state === 'cancelled'
                ? []
                : state === 'completed' || state === 'stopped'
                  ? ['check']
                  : ['check', 'stop']
          const result = readable ? action.result : null
          return {
            ...message,
            briefingAction: {
              actionId: action.envelope.actionId,
              messageId: message.id,
              state,
              allowedControls,
              terminalReceivedAt: action.terminalReceivedAt,
              ...(result
                ? {
                    result: {
                      id: result.receipt.resultId,
                      title: manifest.source.slug,
                      byteLength: result.receipt.byteLength,
                    },
                  }
                : {}),
            },
          }
        }),
      }
    },
    async control(input: unknown) {
      if (disposed) throw new Error('briefing-disposed')
      const { value, action } = exactAction(input, ['actionId', 'messageId', 'command'])
      if (!['check', 'stop', 'cancel'].includes(String(value.command))) throw new Error('briefing-input-invalid')
      if (value.command === 'cancel' && action.state !== 'prepared' && action.state !== 'cancelled-unsubmitted')
        throw new Error('briefing-cancel-after-dispatch')
      if (value.command === 'check') await service.check(action.envelope.actionId)
      else await service.stop(action.envelope.actionId)
    },
    async openResult(input: unknown) {
      const { value, action } = exactAction(input, ['actionId', 'messageId', 'resultId'])
      identity(value.resultId)
      const epoch = invalidationEpoch
      assertAction(action, 'historical')
      if (!action.result || action.result.receipt.resultId !== value.resultId || action.state !== 'completed')
        throw new Error('briefing-result-unavailable')
      await freshPage(lifetime.signal)
      assertEpoch(epoch)
      const current = store.action(action.envelope.actionId)!
      assertAction(current, 'historical')
      if (!current.result || current.result.receipt.resultId !== value.resultId)
        throw new Error('briefing-result-unavailable')
      const title = page().title
      assertEpoch(epoch)
      return { title, content: current.result.content }
    },
    invalidate: () => disableGrant(true),
    async dispose() {
      if (disposed) return
      disposed = true
      invalidationEpoch += 1
      previews.clear()
      lifetime.abort()
      await service.dispose()
    },
  }
  return bridge
}
