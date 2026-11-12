import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { type AgentTurnStep, CHANNELS } from '@remember/shared'
import { app, BrowserWindow, type IpcMainInvokeEvent, ipcMain } from 'electron'
import type { createAgentInteractions } from './agentInteractions'
import { getAgentLearningPolicyToken } from './agentLearning'
import { cancelAgentTurn, runAgentTurn } from './agentTurn'
import { getAssistantAttention, publishAssistantAttention, subscribeAssistantAttention } from './assistantAttention'
import { createNativeBriefing } from './briefingNative'
import { currentProactivePolicyToken } from './dailyReview'
import { createDayAnalysisValidationScope, dayAnalysisProvenancePermitted } from './dailyReview/dayAnalysisProvenance'
import { dailyReviewDirectory, getEvidenceStore } from './dailyReview/evidenceRepository'
import type { ProactiveDecision } from './dailyReview/proactiveStore'
import { readUserActivity } from './dailyReview/userActivityReader'
import { getDictationHistorySnapshot, subscribeDictationHistoryChanges } from './dictation/historySource'
import { createNativeHostTasks } from './hostTaskNative'
import { createNativeConversationArchive } from './nativeConversationArchive'
import { isOfflineMode, requireNetworkAccess } from './networkAccess'
import { RESIDENT_AGENT_INSTRUCTIONS } from './residentAgentInstructions'
import { readResidentSelfProfile, validateResidentMemorySources } from './residentAgentMemory'
import { createResidentMemoryTool } from './residentAgentMemoryTool'
import { agentEvidencePermitted, selectAgentTasks, selectProactiveSources } from './residentAgentPrivacy'
import { createResidentAgentService } from './residentAgentService'
import { ResidentAgentStore } from './residentAgentStore'
import { subscribeResidentTaskSuggestions } from './residentAgentSuggestions'
import { createResidentArchiveSession } from './residentArchiveSession'
import { RESIDENT_ARCHIVE_GUIDE } from './residentArchiveTool'
import { createResidentConversationOwner } from './residentConversationOwner'
import { createResidentDataTool, localDate, noteHistoryChanged } from './residentDataTool'
import { createResidentHostDriver } from './residentHostDriver'
import { emitProactiveConversationChanged, registerProactiveConversation } from './residentProactive'
import { residentProgressLabel } from './residentProgress'
import { type BriefingReplyReference, isInitiativeReplyReference } from './residentReplyContext'
import { createResidentTaskTool } from './residentTaskTool'
import { createResidentTurnTools } from './residentTurnTools'
import { getInterfaceLocale, getSettings, subscribeSettingsChanges } from './settings'
import { createWikiPagePermission } from './userBrief'
import { subscribeWikiContentChanges, subscribeWikiContextInvalidation } from './wikiContextEvents'
import {
  createWikiPage,
  deleteWikiPage,
  getWikiOverview,
  getWikiPageHistoryForSpace,
  listWikiPages,
  proposeWikiPageChange,
  readWikiContextSnapshot,
  saveWikiPage,
} from './wikiSpaceStore'

export function registerResidentAgent(
  interactions: ReturnType<typeof createAgentInteractions>,
  displaySenderAllowed: (event: IpcMainInvokeEvent) => boolean
) {
  const directory = path.join(dailyReviewDirectory(), 'assistant')
  const workspace = path.join(directory, 'workspace')
  mkdirSync(workspace, { recursive: true, mode: 0o700 })
  const qaHostEndpoint =
    !app.isPackaged && process.env.REMEMBER_QA_HOST_JOB_ENABLED === '1'
      ? process.env.REMEMBER_QA_HOST_JOB_ENDPOINT
      : undefined
  const hostDriver = qaHostEndpoint ? createResidentHostDriver(qaHostEndpoint) : null
  const agentExecution = () =>
    hostDriver && getSettings().agentComputer.kind === 'remote' ? ('remote' as const) : ('local' as const)
  const evidenceStore = getEvidenceStore()
  const chatStore = new ResidentAgentStore(path.join(directory, 'conversation.sqlite'))
  const taskEnabled = !app.isPackaged && process.env.REMEMBER_QA_HOST_TASK_ENABLED === '1'
  if (taskEnabled && qaHostEndpoint) throw new Error('host-task-gates-conflict')
  const nativeTasks = taskEnabled
    ? createNativeHostTasks({ resident: chatStore, evidence: evidenceStore, interactions })
    : null
  if (!hostDriver && !nativeTasks) chatStore.retireRemoteExecution()
  const assertAvailable = () => {
    requireNetworkAccess()
    if (!getSettings().cloudAnalysisConsent) throw new Error('cloud-analysis-consent-required')
  }
  const briefingEnabled = !app.isPackaged && process.env.REMEMBER_QA_BRIEFING_ENABLED === '1'
  if (briefingEnabled && qaHostEndpoint) throw new Error('briefing-gates-conflict')
  let refreshAttention = () => {}
  const notifyRenderer = () => {
    refreshAttention()
    for (const window of BrowserWindow.getAllWindows())
      if (!window.isDestroyed()) window.webContents.send(CHANNELS.assistantChanged)
  }
  const notifyConversation = () => {
    notifyRenderer()
    emitProactiveConversationChanged()
  }
  const briefings = briefingEnabled
    ? createNativeBriefing({
        resident: chatStore,
        evidence: evidenceStore,
        currentPolicyToken: currentProactivePolicyToken,
        attentionAvailable: () => service.proactiveAttention().available,
        changed: notifyConversation,
        error: (error) => console.error('[briefing] action unavailable', error),
      })
    : null
  const spaces = () => getWikiOverview([]).spaces
  const pagePermitted = createWikiPagePermission(evidenceStore)
  const withSourceValidation = createDayAnalysisValidationScope(evidenceStore)
  const currentInitiativeSources = (decision: ProactiveDecision) =>
    withSourceValidation((scope) => {
      if (!scope.settings.cloudAnalysisConsent || !scope.settings.liveTaskUpdates || isOfflineMode()) return null
      const current = evidenceStore.proactive.get(decision.id)
      if (!current || current.inputHash !== decision.inputHash || current.invalidatedAt !== null) return null
      const sources = current.sourceRefs.map((reference) => evidenceStore.proactive.resolve(reference))
      if (sources.some((source) => !source)) return null
      const allowed = selectProactiveSources(
        sources.filter((source) => source !== null),
        evidenceStore,
        scope.settings,
        scope.checks
      )
      if (
        allowed.omittedCount !== 0 ||
        !current.supportingQuotes.every((entry) =>
          allowed.evidence.some((source) => source.evidenceId === entry.sourceId && source.text.includes(entry.quote))
        )
      )
        return null
      return allowed.evidence
    })
  const service = createResidentAgentService({
    store: chatStore,
    withSourceValidation,
    separateTaskActions: true,
    replyContextPermitted: (references) => {
      try {
        const briefingReferences = references.filter(
          (reference): reference is BriefingReplyReference => !isInitiativeReplyReference(reference)
        )
        if (briefingReferences.length) {
          if (!briefings) return false
          briefings.assertReplyReferences(briefingReferences)
        }
        for (const reference of references) {
          if (isInitiativeReplyReference(reference)) {
            const decision = chatStore.proactiveDecision(reference.messageId)
            if (
              !decision ||
              decision.id !== reference.decisionId ||
              decision.inputHash !== reference.inputHash ||
              decision.kind === 'prepare' ||
              !currentInitiativeSources(decision)
            )
              return false
          }
        }
        return true
      } catch {
        return false
      }
    },
    execution: agentExecution,
    assertAvailable,
    proactive: {
      canPublish: () => interactions.list().length === 0,
      changed: emitProactiveConversationChanged,
      messagePermitted: (message) => {
        if (!message.initiative) return false
        const decision = evidenceStore.proactive.get(message.initiative.decisionId)
        return decision !== null && currentInitiativeSources(decision) !== null
      },
    },
    validateHostContext: (signal) => {
      return validateResidentMemorySources(chatStore.memorySources(), {
        spaces,
        read: (spaceId) => readWikiContextSnapshot(spaceId),
        pagePermitted,
        assertAvailable: () => {
          if (signal.aborted) throw new Error('agent-cancelled')
          assertAvailable()
        },
      })
    },
    context: async () => {
      assertAvailable()
      const capturedPolicy = policy()
      const briefingContext = await briefings?.prepareChatContext()
      const memory = hostDriver
        ? null
        : await readResidentSelfProfile(
            {
              spaces,
              read: (spaceId) => readWikiContextSnapshot(spaceId),
              pagePermitted,
              assertAvailable,
            },
            chatStore.memorySources()
          )
      const activity = hostDriver ? null : readUserActivity(evidenceStore)
      if (policy() !== capturedPolicy) throw new Error('assistant-context-changed')
      return {
        text: JSON.stringify({
          today: localDate(Date.now()),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          execution: agentExecution(),
          sources: RESIDENT_ARCHIVE_GUIDE,
          ...(memory ? { profile: memory.sources } : {}),
          ...(activity ? { activity } : {}),
          ...(briefingContext ? { briefings: briefingContext.briefings } : {}),
        }),
        ...(memory ? { memory } : {}),
        replyContext: {
          references: briefingContext?.references ?? [],
          assertCurrent: () => {
            if (policy() !== capturedPolicy) throw new Error('assistant-context-changed')
            for (const source of memory?.sources ?? []) {
              const history = getWikiPageHistoryForSpace({ spaceId: source.spaceId, slug: source.slug })
              if (history.headRevisionId !== source.revision || !pagePermitted(source.spaceId, source))
                throw new Error('assistant-context-changed')
            }
            briefingContext?.assertCurrent()
          },
        },
      }
    },
    changed: notifyRenderer,
    driver: {
      run: (input) => {
        const {
          turnId,
          provider,
          prompt,
          instruction,
          threadId,
          onThread,
          onUpdate,
          recovery,
          hostRun,
          onHostRun,
          assertContextCurrent,
          conversationTool,
          onDispatch,
        } = input
        const capturedPolicy = policy()
        const guard = () => {
          assertAvailable()
          assertContextCurrent?.()
          if (policy() !== capturedPolicy) throw new Error('assistant-context-changed')
        }
        guard()
        const computer = hostDriver ? getSettings().agentComputer : { kind: 'local' as const }
        const makeMemoryTool = (searchLimit?: number) =>
          createResidentMemoryTool(instruction, {
            messageId: turnId,
            searchLimit,
            locale: getInterfaceLocale,
            resultChanged: () => {
              for (const window of BrowserWindow.getAllWindows()) {
                if (window.isDestroyed()) continue
                window.webContents.send(CHANNELS.memoryChanged)
                window.webContents.send(CHANNELS.assistantChanged)
              }
            },
            spaces,
            read: readWikiContextSnapshot,
            pagePermitted,
            store: chatStore,
            assertAvailable: () => {
              guard()
            },
            wiki: {
              getSpaces: spaces,
              listPages: listWikiPages,
              createPage: createWikiPage,
              savePage: saveWikiPage,
              deletePage: (spaceId, slug) => deleteWikiPage({ spaceId, slug }),
              proposePage: proposeWikiPageChange,
            },
            ask: (request, signal) => interactions.ask({ ...request, turnId }, signal),
          })
        const archiveSession = !hostDriver
          ? createResidentArchiveSession({
              run: createNativeConversationArchive(guard),
              assertCurrent: guard,
              locale: getInterfaceLocale() === 'nl' ? 'nl' : 'en',
              instruction,
              recovery: Boolean(recovery),
            })
          : null
        const dataTool = createResidentDataTool({
          asOf: Date.now(),
          store: evidenceStore,
          settings: getSettings,
          notes: getDictationHistorySnapshot,
          daySummaryPermitted: (provenance) => dayAnalysisProvenancePermitted(provenance, evidenceStore),
          assertCurrent: guard,
        })
        const taskTool = createResidentTaskTool({
          messageId: turnId,
          locale: getInterfaceLocale,
          evidence: evidenceStore,
          store: chatStore,
          permitted: (item) =>
            selectAgentTasks([item], {
              contextEvidence: (workdayId, observedAt) => evidenceStore.readTaskContextEvidence(workdayId, observedAt),
              settings: getSettings(),
              provenance: evidenceStore.ambientTasks,
            }).length === 1,
          assertAvailable: guard,
          ask: (request, signal) => interactions.ask({ ...request, turnId }, signal),
          changed: () => {
            for (const window of BrowserWindow.getAllWindows())
              if (!window.isDestroyed()) window.webContents.send(CHANNELS.memoryChanged)
            notifyRenderer()
          },
        })
        const progressSteps: AgentTurnStep[] = []
        let progressSequence = 0
        const dutchProgress =
          /\b(ik|mijn|welke?|hoe|vandaag|gisteren)\b/i.test(instruction) || getInterfaceLocale() === 'nl'
        const reportProgress = (text: string) => {
          guard()
          if (progressSteps.at(-1)?.text === text) return
          const step: AgentTurnStep = {
            id: `remember-progress-${progressSequence++}`,
            kind: 'reasoning',
            text,
            at: Date.now(),
          }
          progressSteps.push(step)
          if (progressSteps.length > 32) progressSteps.shift()
          onUpdate({ ...step, turnId, provider, type: 'reasoning' })
        }
        const tools = createResidentTurnTools({
          memory: makeMemoryTool,
          data: dataTool,
          task: taskTool,
          archive: archiveSession,
          conversation: conversationTool,
          onCall: (tool, raw) => {
            const label = residentProgressLabel(tool, (raw as { action?: unknown } | null)?.action, dutchProgress)
            if (label) reportProgress(label)
          },
        })
        const executionInstructions =
          computer.kind === 'remote'
            ? "You run on the configured remote agent computer. Screen/audio context in this message was selected on the user's primary Mac. Your tools act on the remote computer; do not confuse the two computers. Only use tools actually exposed by this remote runtime."
            : "You run locally in Remember's workspace on this Mac. No remote computer is connected for this turn."
        if (hostRun || (hostDriver && computer.kind === 'remote')) {
          if (!hostDriver || computer.kind !== 'remote' || provider !== 'codex')
            throw new Error('host-driver-unavailable')
          return hostDriver.run({
            turnId,
            prompt,
            instruction,
            threadId,
            hostRun,
            onHostRun,
            onThread,
            onUpdate,
            computer,
            model: getSettings().codexAnalysisModel,
            effort: getSettings().codexAnalysisEffort,
            instructions: `${RESIDENT_AGENT_INSTRUCTIONS}\n${executionInstructions}\nUse remember_memory for scoped Space reads and reviewed writes. This tool runs in Remember on the primary Mac and waits while that client is closed. Never treat absence as approval.`,
            tools,
            ask: (request, signal) => interactions.ask({ ...request, turnId }, signal),
            assertAvailable: () => {
              assertAvailable()
            },
          })
        }
        return runAgentTurn(
          { turnId, provider, prompt },
          (update) => {
            if (archiveSession?.requiresValidation() && (update.type === 'response' || update.type === 'reasoning'))
              return
            onUpdate(update)
          },
          {
            kind: 'assistant',
            finalizeResponse: archiveSession
              ? async (response, signal) => {
                  if (archiveSession.hasSourceReads())
                    reportProgress(
                      dutchProgress
                        ? 'Ik controleer of de gebruikte bronnen nog actueel zijn.'
                        : 'I’m checking that the sources used are still current.'
                    )
                  return archiveSession.finalize(response, signal)
                }
              : undefined,
            assertCurrent: guard,
            onDispatch,
            instructions: `${RESIDENT_AGENT_INSTRUCTIONS}\n${executionInstructions}\n${archiveSession ? RESIDENT_ARCHIVE_GUIDE : ''}\nRelevant Space knowledge is provided with source URLs and revisions for grounding. Keep revisions and raw identifiers out of normal replies. Use a short human-readable page link when useful; provide source details when asked. Use remember_memory for scoped search/read and reviewed revision-aware writes. It runs locally in Remember on this Mac. A proposed change is not a saved page. Do not claim this tool exists when it is absent from your available tools.`,
            tools,
            computer: { kind: 'local' },
            workingDirectory: workspace,
            // The canonical SQLite transcript is supplied above on every turn.
            // A provider session would retain source content we can no longer filter.
            threadId: null,
            onThread: () => {},
            ask: async (request, signal) => {
              guard()
              const answer = await interactions.ask({ ...request, turnId }, signal)
              guard()
              return answer
            },
          }
        ).then((result) =>
          archiveSession
            ? {
                ...result,
                steps: [
                  ...result.steps.filter((step) => step.kind !== 'reasoning' || !archiveSession.requiresValidation()),
                  ...progressSteps,
                ].slice(-32),
              }
            : result
        )
      },
      ...(hostDriver ? { detachHost: hostDriver.detach, stopHost: hostDriver.stop } : {}),
      cancel: (turnId) => {
        hostDriver?.detach(turnId)
        cancelAgentTurn(turnId)
      },
    },
  })
  const owner = nativeTasks
    ? createResidentConversationOwner({
        chat: service,
        tasks: nativeTasks,
        onTaskInput: () => {
          chatStore.noteConversationInput()
          emitProactiveConversationChanged()
        },
      })
    : null
  const trusted = (event: IpcMainInvokeEvent) => {
    if (!displaySenderAllowed(event)) throw new Error('assistant-untrusted-sender')
  }
  refreshAttention = () => {
    const available = !isOfflineMode() && getSettings().cloudAnalysisConsent
    const host = available ? chatStore.hostRun() : null
    publishAssistantAttention({
      unread: available && chatStore.hasUnreadMessages(),
      needsInput: available && (interactions.list().length > 0 || (host?.phase === 'waiting' && !host.stopRequested)),
    })
  }
  const unsubscribeAttention = subscribeAssistantAttention((state) => {
    for (const window of BrowserWindow.getAllWindows())
      if (!window.isDestroyed()) window.webContents.send(CHANNELS.assistantAttentionChanged, state)
  })
  const unsubscribeAttentionInteractions = interactions.subscribe(refreshAttention)
  ipcMain.handle(CHANNELS.getAssistantAttention, (event) => {
    trusted(event)
    return getAssistantAttention()
  })
  ipcMain.handle(CHANNELS.markAssistantRead, (event, messageId: unknown) => {
    trusted(event)
    if (typeof messageId !== 'string' || messageId.length > 200) throw new Error('assistant-read-invalid')
    readsLifetime.signal.throwIfAborted()
    chatStore.markRead(messageId)
    refreshAttention()
  })
  refreshAttention()
  const readsLifetime = new AbortController()
  const warmedSnapshots = new Map<string, { policy: string; promise: Promise<void> }>()
  let sourceReadsReady = false
  const warmSnapshotSources = async (beforeMessageId?: string) => {
    readsLifetime.signal.throwIfAborted()
    const settings = getSettings()
    if (settings.cloudAnalysisConsent && settings.liveTaskUpdates && !isOfflineMode()) {
      const policy = JSON.stringify(settings)
      const ids = new Set<string>()
      for (const message of chatStore.conversation(null, beforeMessageId).messages) {
        const references = [
          message.id,
          ...chatStore
            .replyContext(message.id)
            .filter(isInitiativeReplyReference)
            .map((reference) => reference.messageId),
        ]
        for (const id of references) {
          const decision = chatStore.proactiveDecision(id)
          if (!decision) continue
          const current = evidenceStore.proactive.get(decision.id)
          if (!current || current.invalidatedAt !== null || current.inputHash !== decision.inputHash) continue
          for (const source of current.sourceRefs) if (source.kind === 'day') ids.add(source.sourceId)
        }
      }
      for (const id of ids) {
        let entry = warmedSnapshots.get(id)
        if (!entry || entry.policy !== policy) {
          entry = {
            policy,
            promise: evidenceStore.proactive.warmDaySource(
              id,
              policy,
              (evidence) => agentEvidencePermitted(evidence, settings),
              readsLifetime.signal
            ),
          }
          warmedSnapshots.set(id, entry)
        }
        try {
          await entry.promise
        } catch (error) {
          if (warmedSnapshots.get(id) === entry) warmedSnapshots.delete(id)
          throw error
        }
        while (warmedSnapshots.size > 64) {
          const oldest = warmedSnapshots.keys().next().value
          if (oldest === undefined) break
          warmedSnapshots.delete(oldest)
        }
      }
    }
    readsLifetime.signal.throwIfAborted()
    if (!sourceReadsReady) {
      sourceReadsReady = true
      emitProactiveConversationChanged()
    }
  }
  const snapshot = async (beforeMessageId?: string) => {
    await warmSnapshotSources(beforeMessageId)
    readsLifetime.signal.throwIfAborted()
    const conversation = owner ? await owner.snapshot(beforeMessageId) : service.snapshot(beforeMessageId)
    return briefings ? briefings.enrichSnapshot(conversation) : conversation
  }
  const briefing = (event: IpcMainInvokeEvent) => {
    trusted(event)
    if (!briefings) throw new Error('briefing-qa-disabled')
    return briefings
  }
  ipcMain.handle(CHANNELS.previewAssistantBriefingGrant, (event) => briefing(event).previewGrant())
  ipcMain.handle(CHANNELS.confirmAssistantBriefingGrant, async (event, token: unknown) => {
    await briefing(event).confirmGrant(token)
    return snapshot()
  })
  ipcMain.handle(CHANNELS.revokeAssistantBriefingGrant, async (event, id: unknown) => {
    await briefing(event).revokeGrant(id)
    return snapshot()
  })
  ipcMain.handle(CHANNELS.controlAssistantBriefing, async (event, input: unknown) => {
    await briefing(event).control(input)
    return snapshot()
  })
  ipcMain.handle(CHANNELS.openAssistantBriefing, (event, input: unknown) => briefing(event).openResult(input))
  ipcMain.handle(CHANNELS.getAssistantTaskActionsEnabled, (event) => {
    trusted(event)
    return Boolean(owner)
  })
  ipcMain.handle(CHANNELS.getAssistantConversation, (event, beforeMessageId: unknown) => {
    trusted(event)
    if (beforeMessageId !== undefined && (typeof beforeMessageId !== 'string' || beforeMessageId.length > 200))
      throw new Error('invalid-assistant-message')
    return snapshot(beforeMessageId)
  })
  ipcMain.handle(CHANNELS.getAssistantTaskDraft, (event, input: unknown) => {
    trusted(event)
    if (!owner) throw new Error('host-task-qa-disabled')
    return owner.draft(input)
  })
  ipcMain.handle(CHANNELS.controlAssistantTask, async (event, input: unknown) => {
    trusted(event)
    if (!owner) throw new Error('host-task-qa-disabled')
    await owner.control(input)
    return snapshot()
  })
  ipcMain.handle(CHANNELS.sendAssistantMessage, async (event, input: unknown) => {
    if (owner) {
      trusted(event)
      const conversation = await owner.send(input)
      return briefings ? briefings.enrichSnapshot(conversation) : conversation
    }
    if (input && typeof input === 'object' && Object.hasOwn(input, 'task')) throw new Error('host-task-qa-disabled')
    trusted(event)
    const conversation = service.send(input)
    return briefings ? briefings.enrichSnapshot(conversation) : conversation
  })
  ipcMain.handle(CHANNELS.sendAssistantQueuedMessage, async (event, input: unknown) => {
    trusted(event)
    await service.sendQueued(input)
    return snapshot()
  })
  ipcMain.handle(CHANNELS.retryAssistantMessage, async (event, messageId: unknown) => {
    trusted(event)
    if (briefings) {
      if (typeof messageId !== 'string' || chatStore.initiatives.ownsMessage(messageId))
        throw new Error('initiative-exact-control-required')
    }
    if (owner) {
      await owner.retry(messageId)
      return snapshot()
    }
    if (typeof messageId !== 'string') throw new Error('invalid-assistant-message')
    service.retry(messageId)
    return snapshot()
  })
  ipcMain.handle(CHANNELS.cancelAssistantTurn, (event, messageId: unknown) => {
    if (messageId !== undefined && (typeof messageId !== 'string' || !messageId || messageId.length > 200))
      throw new Error('invalid-assistant-message')
    trusted(event)
    if (owner) {
      trusted(event)
      return owner.cancel(messageId)
    }
    return service.cancel(messageId)
  })
  ipcMain.handle(CHANNELS.setAssistantComposing, (event, active: unknown) => {
    if (!displaySenderAllowed(event)) throw new Error('assistant-untrusted-sender')
    service.setComposing(event.sender.id, active)
  })
  ipcMain.handle(CHANNELS.dismissAssistantInitiative, async (event, messageId: unknown) => {
    if (!displaySenderAllowed(event)) throw new Error('assistant-untrusted-sender')
    if (typeof messageId !== 'string') throw new Error('invalid-assistant-message')
    if (chatStore.initiatives.ownsMessage(messageId)) throw new Error('initiative-exact-control-required')
    service.dismissProactiveInitiative(messageId)
    return snapshot()
  })
  const unregisterProactive = registerProactiveConversation({
    attention: () => {
      const current = service.proactiveAttention()
      return {
        ...current,
        available: sourceReadsReady && current.available && chatStore.initiatives.unresolved().length === 0,
      }
    },
    state: () => {
      if (!sourceReadsReady)
        return {
          ...service.proactiveAttention(),
          available: false,
          recentMessages: [],
          recentInitiatives: [],
          dismissedTopics: [],
        }
      const current = service.proactiveState()
      return { ...current, available: current.available && chatStore.initiatives.unresolved().length === 0 }
    },
    deliver: (decision) => {
      const existing = service.deliveredProactiveInitiative(decision.id, decision.inputHash)
      const messageId = service.deliverProactiveInitiative(decision)
      if (briefings && messageId && !existing)
        queueMicrotask(() => {
          const current = evidenceStore.proactive.get(decision.id)
          if (current?.deliveredMessageId === messageId)
            void briefings
              .consider(current, messageId)
              .catch((error) => console.error('[briefing] admission refused', error))
        })
      return messageId
    },
    briefingCandidateSourceIds: (sources) => briefings?.candidateSourceIds(sources) ?? [],
    delivered: service.deliveredProactiveInitiative,
  })
  const unsubscribeInteractions = interactions.subscribe(emitProactiveConversationChanged)

  const policy = () => {
    const settings = getSettings()
    return JSON.stringify([
      'resident-memory-tools-v2',
      settings.liveTaskUpdates,
      settings.cloudAnalysisConsent,
      getAgentLearningPolicyToken(),
      agentExecution(),
      'local-agent-v1',
      evidenceStore.deletionRevision(),
      settings.offlineMode,
      settings.excludePasswordManagers,
      settings.excludePrivateBrowsing,
      settings.appCaptureMode,
      settings.excludedAppBundleIds,
      settings.includedAppBundleIds,
      settings.websiteCaptureMode,
      settings.excludedWebsites,
      settings.includedWebsites,
    ])
  }
  let currentPolicy = policy()
  void service
    .setContextPolicy(currentPolicy)
    .then(() => {
      if (hostDriver) service.resumeHost()
      return warmSnapshotSources()
    })
    .catch((error) => {
      if (!readsLifetime.signal.aborted) console.error('[assistant] policy recovery failed', error)
    })
  const synchronizePolicy = () => {
    const next = policy()
    if (next === currentPolicy) return
    currentPolicy = next
    void service.setContextPolicy(next).catch((error) => console.error('[assistant] policy cancellation failed', error))
  }
  const unsubscribeSettings = subscribeSettingsChanges(synchronizePolicy)
  const unsubscribeDeletion = evidenceStore.subscribeEvidenceDeletion(synchronizePolicy)
  const unsubscribeWiki = subscribeWikiContextInvalidation(() => {
    void service
      .invalidateContext()
      .catch((error) => console.error('[assistant] Wiki context invalidation failed', error))
  })
  const unsubscribeWikiContent = subscribeWikiContentChanges(notifyRenderer)
  let previousNotes = getDictationHistorySnapshot()
  const unsubscribeNotes = subscribeDictationHistoryChanges(() => {
    const nextNotes = getDictationHistorySnapshot()
    const changed = noteHistoryChanged(previousNotes, nextNotes)
    if (nextNotes.state === 'available') previousNotes = nextNotes
    if (changed)
      void service.invalidateContext().catch((error) => console.error('[assistant] note invalidation failed', error))
    notifyConversation()
  })
  const unsubscribeSuggestions = subscribeResidentTaskSuggestions((input) => service.appendTaskSuggestion(input))
  return {
    ...service,
    ...(owner
      ? {
          snapshot: owner.snapshot,
          send: owner.send,
          retry: owner.retry,
          cancel: owner.cancel,
          prepareForDeletion: owner.prepareForDeletion,
        }
      : {}),
    snapshot,
    async prepareForDeletion() {
      await briefings?.invalidate()
      if (owner) await owner.prepareForDeletion()
      else await service.prepareForDeletion()
    },
    async dispose() {
      refreshAttention = () => {}
      unsubscribeAttention()
      unsubscribeAttentionInteractions()
      publishAssistantAttention({ unread: false, needsInput: false })
      readsLifetime.abort()
      warmedSnapshots.clear()
      unregisterProactive()
      unsubscribeInteractions()
      unsubscribeSettings()
      unsubscribeDeletion()
      unsubscribeWiki()
      unsubscribeWikiContent()
      unsubscribeNotes()
      unsubscribeSuggestions()
      try {
        await briefings?.dispose()
      } finally {
        if (owner) await owner.dispose()
        else await service.dispose()
      }
    },
  }
}
