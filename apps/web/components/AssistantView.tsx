'use client'

import { useLocalBridge } from '@internal/context/LocalBridgeProvider'
import { useI18n } from '@internal/locales'
import { Button } from '@internal/ui/Button'
import { Spinner } from '@internal/ui/Spinner'
import type {
  AgentInteraction,
  AssistantConversation,
  AssistantMessage,
  AssistantTaskAction,
  AssistantTaskDraft,
  LocalSettings,
  RememberBridge,
} from '@remember/shared'
import {
  ArrowDown as IconArrowDown,
  RotateCw as IconArrowRotateClockwise,
  ArrowUp as IconArrowUp,
  Info as IconCircleInfo,
  Square as IconStop,
} from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AgentWorkerControls } from './AgentWorkerControls'
import { AssistantBriefingGrant, AssistantBriefingStatus } from './AssistantBriefing'
import { AssistantCodeBlock } from './AssistantCodeBlock'
import { AssistantCommandMode, AssistantCommandStatus } from './AssistantCommandControls'
import { AssistantProgress } from './AssistantProgress'
import { AssistantMarkdownLink, AssistantReferenceCard } from './AssistantReferenceCard'
import { AssistantSavedResults } from './AssistantSavedResults'
import { AssistantTaskStatus } from './AssistantTaskStatus'
import { reconcileAssistantConversation } from './assistantConversation'
import { remarkAssistantReferences } from './assistantReferences'
import {
  ASSISTANT_OUTBOX_LIMIT,
  type AssistantSession,
  type LocalAssistantSubmission as LocalMessage,
  readAssistantSession,
  restoreAssistantSessionDraft,
  writeAssistantSession,
} from './assistantSession'
import { rehypeStreamingWords } from './assistantStreaming'
import { formatAssistantTimestamp } from './assistantTimestamp'
import { ComposerDictation } from './ComposerDictation'
import { coalesceRefresh } from './localDataRefresh'
import { MarkdownContent } from './MarkdownContent'
import { wikiPageHref } from './wikiRoutes'

function containsSubmission(conversation: AssistantConversation | null, id: string) {
  return Boolean(
    conversation?.messages.some((message) => message.id === id) ||
      conversation?.queuedMessages?.some((message) => message.id === id)
  )
}

function assistantSession(
  drafts: Record<string, string>,
  submissions: LocalMessage[],
  queueEdit: AssistantSession['queueEdit']
): AssistantSession {
  return {
    draft: drafts[''] ?? '',
    scopedDrafts: Object.fromEntries(Object.entries(drafts).filter(([scope, text]) => scope && text)),
    submissions,
    ...(queueEdit ? { queueEdit } : {}),
  }
}

export function AssistantView({ active = true }: { active?: boolean }) {
  const local = useLocalBridge()
  return <AssistantChat active={active} bridge={local.bridge} settings={local.settings} />
}

const AssistantChat = memo(function AssistantChat({
  active,
  bridge,
  settings,
}: {
  active: boolean
  bridge: RememberBridge | null
  settings: LocalSettings | null
}) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const refreshClock = () => setNow(Date.now())
    refreshClock()
    const timer = window.setInterval(refreshClock, 60_000)
    window.addEventListener('focus', refreshClock)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', refreshClock)
    }
  }, [])
  const reducedMotion = useReducedMotion()
  const { t } = useI18n()
  const search = useSearchParams()
  const router = useRouter()
  const taskId = search.get('task')
  const prompt = search.get('prompt')?.slice(0, 20_000)
  const draftScope = taskId ? `task:${taskId}` : prompt ? `prompt:${prompt}` : ''
  const [taskDraft, setTaskDraft] = useState<AssistantTaskDraft | null>(null)
  const [taskLoading, setTaskLoading] = useState(false)
  const [taskError, setTaskError] = useState('')
  const [taskActionError, setTaskActionError] = useState<{ actionId: string; message: string } | null>(null)
  const [taskPending, setTaskPending] = useState<string | null>(null)
  const taskRead = useRef(0)
  const initializedTask = useRef<string | null | undefined>(undefined)
  const draftValue = useRef('')
  const actionLock = useRef(false)
  const taskActionLock = useRef(false)
  const [conversation, replaceConversation] = useState<AssistantConversation | null>(null)
  const setConversation = useCallback((value: AssistantConversation) => {
    replaceConversation((previous) => reconcileAssistantConversation(previous, value))
  }, [])
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [earlierError, setEarlierError] = useState(false)
  const earlierRead = useRef(false)
  const historyAnchor = useRef<{ element: HTMLElement; top: number } | null>(null)
  const conversationRead = useRef(0)
  const [page, setPage] = useState<{ before?: string }>({})
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const draftsRef = useRef(drafts)
  draftsRef.current = drafts
  const [dictating, setDictating] = useState(false)
  const draft = drafts[draftScope] ?? ''
  const setDraft = useCallback(
    (value: string | ((current: string) => string)) => {
      setDrafts((current) => ({
        ...current,
        [draftScope]: typeof value === 'function' ? value(current[draftScope] ?? '') : value,
      }))
    },
    [draftScope]
  )
  const [localMessages, setLocalMessages] = useState<LocalMessage[]>([])
  const [queueEdit, setQueueEdit] = useState<AssistantSession['queueEdit']>()
  const [sessionReady, setSessionReady] = useState(false)
  const sessionReadable = useRef(false)
  const [sessionError, setSessionError] = useState(false)
  const unconfirmedMessages = localMessages.filter((message) => !containsSubmission(conversation, message.id))
  const emptyChat = Boolean(conversation && !conversation.messages.length && !unconfirmedMessages.length && !taskId)
  const [mode, setMode] = useState<'question' | 'command'>('question')
  const [commandError, setCommandError] = useState<{ messageId: string; message: string } | null>(null)
  draftValue.current = draft
  const provider = settings?.defaultAgentProvider ?? 'codex'
  const [requests, setRequests] = useState<AgentInteraction[]>([])
  const [interactionError, setInteractionError] = useState('')
  const interactionReader = useRef<(() => Promise<AgentInteraction[]>) | null>(null)
  const [loadError, setLoadError] = useState('')
  const [actionError, setActionError] = useState<{ message: string; hostStopMessageId?: string } | null>(null)
  const [pending, setPending] = useState(false)
  const [stoppingId, setStoppingId] = useState<string | null>(null)
  const initializedPrompt = useRef<string | null>(null)
  const content = useRef<HTMLDivElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const follow = useRef(true)
  const turnAnchor = useRef<string | null>(null)
  const animateNextScroll = useRef(false)
  const scrollingToTurn = useRef(false)
  const answerSpace = useRef<HTMLDivElement>(null)
  const [awayFromBottom, setAwayFromBottom] = useState(false)
  const lastRead = useRef<string | null>(null)
  const markVisibleRead = useCallback(() => {
    const viewport = scroll.current
    if (
      !active ||
      !bridge?.markAssistantRead ||
      !document.hasFocus() ||
      !viewport ||
      !viewport.checkVisibility() ||
      document.visibilityState !== 'visible' ||
      viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight >= 48
    )
      return
    const message = conversation?.messages.findLast(
      (entry) =>
        entry.role === 'assistant' &&
        ['completed', 'failed', 'interrupted'].includes(entry.status) &&
        (!entry.command || !['reserved', 'dispatching', 'running'].includes(entry.command.state))
    )
    if (!message || lastRead.current === message.id) return
    lastRead.current = message.id
    void bridge.markAssistantRead(message.id).catch(() => {
      if (lastRead.current === message.id) lastRead.current = null
    })
  }, [active, bridge, conversation])
  useEffect(() => {
    markVisibleRead()
    window.addEventListener('focus', markVisibleRead)
    return () => window.removeEventListener('focus', markVisibleRead)
  }, [markVisibleRead])
  const composer = useRef<HTMLTextAreaElement>(null)
  const restoreLocalDraft = useCallback(
    (message: { id: string; text: string }) => {
      const restored = restoreAssistantSessionDraft(assistantSession(drafts, localMessages, queueEdit), message)
      if (!sessionReadable.current || !writeAssistantSession(restored.session)) {
        setSessionError(true)
        return
      }
      setDrafts({ ...restored.session.scopedDrafts, '': restored.session.draft })
      setLocalMessages(restored.session.submissions)
      setQueueEdit(restored.session.queueEdit)
      setSessionError(false)
      setActionError(null)
      router.replace(restored.prompt ? `/assistant/?prompt=${encodeURIComponent(restored.prompt)}` : '/assistant/')
      requestAnimationFrame(() => composer.current?.focus({ preventScroll: true }))
    },
    [drafts, localMessages, queueEdit, router]
  )

  const focusOwner = useRef<{ element: HTMLElement; messageId: string | null | undefined } | null>(null)
  const activeId = conversation?.activeTurnId
  const commandMode = conversation?.commandMode
  const unfinishedCommand = conversation?.messages.find(
    (message) => message.command && !['completed', 'stopped', 'cancelled'].includes(message.command.state)
  )
  const taskActionsEnabled = conversation?.taskActionsEnabled === true
  const sharedTaskChat = conversation?.sharedTaskChat === true
  const activeTaskAction = conversation?.activeTaskAction
  const hostJob = conversation?.hostJob
  const unfinishedHostJob = Boolean(hostJob && !['completed', 'stopped'].includes(hostJob.phase))
  const hostResultNeedsCheck = Boolean(
    hostJob?.phase === 'completed' &&
      conversation?.messages.find((message) => message.id === hostJob.messageId)?.error ===
        'assistant-host-context-unavailable'
  )
  const interactionId = activeTaskAction?.messageId ?? hostJob?.messageId ?? activeId ?? unfinishedCommand?.id
  const hostConnection = hostJob?.connection
  const hostPhase = hostJob?.phase
  const busy =
    pending ||
    Boolean(queueEdit) ||
    Boolean(activeId) ||
    Boolean(unfinishedCommand) ||
    (!sharedTaskChat && Boolean(activeTaskAction))
  const queueing = Boolean(commandMode?.unified && unfinishedCommand && !taskDraft && !taskId)
  const canUseAgent = Boolean(conversation) && !settings?.offlineMode
  const canSend = canUseAgent && settings?.cloudAnalysisConsent === true
  const recoveryRequired = Boolean(conversation?.remoteRecoveryRequired)
  const showStop = Boolean(
    (commandMode?.unified && unfinishedCommand) ||
      (!unfinishedCommand &&
        (sharedTaskChat
          ? activeId || recoveryRequired || unfinishedHostJob
          : !taskActionsEnabled && (activeId || recoveryRequired || unfinishedHostJob)))
  )
  const canCheckHost = Boolean(
    hostJob?.canCheck !== false &&
      (unfinishedHostJob || hostResultNeedsCheck) &&
      hostConnection !== 'connecting' &&
      (hostResultNeedsCheck || hostConnection === 'disconnected' || hostPhase === 'recovery-required')
  )
  const hostReviewReady = hostConnection === 'connected' && hostPhase === 'waiting' && !settings?.offlineMode
  const hasTaskAction = Boolean(activeTaskAction)
  const taskReviewReady =
    activeTaskAction?.connection === 'connected' &&
    activeTaskAction.state === 'waiting' &&
    !settings?.offlineMode &&
    settings?.cloudAnalysisConsent === true
  const visibleRequests = activeTaskAction
    ? taskReviewReady
      ? requests.filter((request) => request.turnId === activeTaskAction.messageId)
      : []
    : hostJob
      ? hostReviewReady
        ? requests.filter((request) => request.turnId === hostJob.messageId)
        : []
      : requests
  const hostStopRepresented = Boolean(
    hostJob &&
      actionError?.hostStopMessageId === hostJob.messageId &&
      (['completed', 'stopped'].includes(hostJob.phase) ||
        (hostJob.stopRequested &&
          (hostJob.connection !== 'connected' || hostJob.phase === 'recovery-required') &&
          conversation?.messages.some((message) => message.id === hostJob.messageId)))
  )
  const visibleActionError = hostStopRepresented ? null : actionError
  const error =
    (!queueEdit && visibleActionError?.message) ||
    loadError ||
    (sessionError ? t('Je concept kan niet lokaal worden bewaard. Houd dit venster open en probeer opnieuw.') : '')

  useEffect(() => {
    if (!bridge || sessionReady) return
    const saved = readAssistantSession()
    sessionReadable.current = saved !== null
    if (saved) {
      setLocalMessages(saved.submissions)
      setDrafts({ ...saved.scopedDrafts, '': saved.draft })
      setQueueEdit(saved.queueEdit)
    }
    setSessionError(saved === null)
    setSessionReady(true)
  }, [bridge, sessionReady])

  useEffect(() => {
    if (!sessionReady || !sessionReadable.current) return
    setSessionError(!writeAssistantSession(assistantSession(drafts, localMessages, queueEdit)))
  }, [drafts, localMessages, queueEdit, sessionReady])

  useEffect(() => {
    if (sessionReady && conversation && !conversation.commandMode && queueEdit) restoreLocalDraft(queueEdit)
  }, [sessionReady, conversation, queueEdit, restoreLocalDraft])

  useEffect(() => {
    setLocalMessages((current) => {
      const remaining = current.filter((message) => !containsSubmission(conversation, message.id))
      return remaining.length === current.length ? current : remaining
    })
  }, [conversation])

  const updateComposing = (active: boolean) => {
    if (!conversation?.proactiveEnabled) return
    void bridge?.setAssistantComposing?.(active).catch(() => {})
  }

  useEffect(() => {
    if (!bridge?.setAssistantComposing || !conversation?.proactiveEnabled) return
    const publish = (active: boolean) => void bridge.setAssistantComposing?.(active).catch(() => {})
    const timer = window.setInterval(() => {
      if (document.hasFocus() && document.activeElement === composer.current && draftValue.current.trim()) publish(true)
    }, 5000)
    const blur = () => publish(false)
    window.addEventListener('blur', blur)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('blur', blur)
      publish(false)
    }
  }, [bridge, conversation?.proactiveEnabled])

  const retainControlFocus = (element: HTMLElement, messageId = interactionId) => {
    focusOwner.current = document.hasFocus() ? { element, messageId } : null
  }

  useEffect(() => {
    const clear = () => {
      focusOwner.current = null
    }
    const moved = (event: Event) => {
      if (event.target !== focusOwner.current?.element) clear()
    }
    document.addEventListener('focusin', moved)
    window.addEventListener('blur', clear)
    return () => {
      clear()
      document.removeEventListener('focusin', moved)
      window.removeEventListener('blur', clear)
    }
  }, [])

  useLayoutEffect(() => {
    const owner = focusOwner.current
    if (!owner) return
    if (!document.hasFocus()) {
      focusOwner.current = null
      return
    }
    const active = document.activeElement
    if (active === owner.element || pending) return
    if (active !== document.body && active !== document.documentElement) {
      focusOwner.current = null
      return
    }
    if (owner.messageId === interactionId && owner.element.isConnected) {
      if (!owner.element.matches(':disabled')) owner.element.focus({ preventScroll: true })
      return
    }
    focusOwner.current = null
    composer.current?.focus({ preventScroll: true })
  })

  useEffect(() => {
    if (sessionReady && !taskId && prompt && initializedPrompt.current !== prompt) {
      initializedPrompt.current = prompt
      setDraft((current) => current || prompt)
    }
  }, [prompt, taskId, sessionReady, setDraft])

  const loadTaskDraft = useCallback(
    async (preserveText: boolean) => {
      if (!bridge || !taskId || !taskActionsEnabled) return
      const generation = ++taskRead.current
      const originalText = draftValue.current
      setTaskLoading(true)
      setTaskError('')
      try {
        const value = await bridge.getAssistantTaskDraft(taskId)
        if (generation !== taskRead.current) return
        setTaskDraft(value)
        if (!preserveText && !originalText && !draftValue.current) setDraft(value.text)
      } catch {
        if (generation === taskRead.current) {
          setTaskDraft(null)
          setTaskError(t('De taak kon niet worden geladen. Je concept blijft bewaard.'))
        }
      } finally {
        if (generation === taskRead.current) setTaskLoading(false)
      }
    },
    [bridge, taskId, taskActionsEnabled, setDraft, t]
  )

  useEffect(() => {
    if (!sessionReady) return
    const key = taskActionsEnabled ? taskId : null
    if (initializedTask.current === key) return
    initializedTask.current = key
    taskRead.current += 1
    setTaskDraft(null)
    setTaskError('')
    setTaskLoading(false)
    if (key) void loadTaskDraft(false)
  }, [taskId, taskActionsEnabled, loadTaskDraft, sessionReady])

  useEffect(
    () => () => {
      taskRead.current += 1
      initializedTask.current = undefined
    },
    []
  )

  useEffect(() => {
    if (!bridge) return
    let alive = true
    let timer: ReturnType<typeof setTimeout> | null = null
    const refresh = coalesceRefresh(async () => {
      if (!alive) return
      const current = ++conversationRead.current
      try {
        const value = await bridge.getAssistantConversation(page.before)
        if (alive && current === conversationRead.current) {
          setConversation(value)
          setLoadError('')
        }
      } catch {
        if (alive && current === conversationRead.current) setLoadError(t('Het gesprek kon niet worden geladen.'))
      }
    })
    const unsubscribe = bridge.onAssistantChanged(() => {
      if (timer) return
      timer = setTimeout(() => {
        timer = null
        void refresh()
      }, 80)
    })
    void refresh()
    return () => {
      alive = false
      unsubscribe()
      if (timer) clearTimeout(timer)
    }
  }, [bridge, page, setConversation, t])

  useEffect(() => {
    if (!bridge) return
    if (
      (hasTaskAction && !taskReviewReady) ||
      (hostConnection && (hostConnection !== 'connected' || hostPhase !== 'waiting'))
    ) {
      setRequests([])
      setInteractionError('')
      return
    }
    let alive = true
    let generation = 0
    const refresh = async (reportError = true) => {
      const current = ++generation
      try {
        const value = await bridge.getAgentInteractions()
        if (!alive || current !== generation) throw new Error('agent-interaction-read-superseded')
        const scoped = value.filter((request) => request.turnId === interactionId)
        setRequests(scoped)
        setInteractionError('')
        return scoped
      } catch (error) {
        if (reportError && alive && current === generation) setInteractionError(t('Vragen konden niet worden geladen.'))
        throw error
      }
    }
    const read = () => refresh(false)
    interactionReader.current = read
    const refreshFromEvent = () => void refresh().catch(() => {})
    const unsubscribe = bridge.onAgentInteractionsChanged(refreshFromEvent)
    refreshFromEvent()
    return () => {
      alive = false
      if (interactionReader.current === read) interactionReader.current = null
      unsubscribe()
    }
  }, [bridge, interactionId, hostConnection, hostPhase, hasTaskAction, taskReviewReady, t])

  const loadEarlier = useCallback(async () => {
    const viewport = scroll.current
    const firstId = conversation?.messages[0]?.id
    if (!bridge || !viewport || !firstId || !conversation?.hasEarlier || earlierRead.current) return
    earlierRead.current = true
    setLoadingEarlier(true)
    setEarlierError(false)
    try {
      const older = await bridge.getAssistantConversation(firstId)
      const element = content.current?.querySelector<HTMLElement>(
        '[data-assistant-user-message], [data-assistant-message]'
      )
      if (element) historyAnchor.current = { element, top: element.getBoundingClientRect().top }
      replaceConversation((current) => {
        if (!current || current.messages[0]?.id !== firstId) return current
        const ids = new Set(current.messages.map((message) => message.id))
        return {
          ...current,
          hasEarlier: older.hasEarlier,
          messages: [...older.messages.filter((message) => !ids.has(message.id)), ...current.messages],
        }
      })
    } catch {
      setEarlierError(true)
    } finally {
      earlierRead.current = false
      setLoadingEarlier(false)
    }
  }, [bridge, conversation])

  useLayoutEffect(() => {
    const anchor = historyAnchor.current
    if (anchor && scroll.current) {
      scroll.current.scrollTop += anchor.element.getBoundingClientRect().top - anchor.top
      historyAnchor.current = null
    }
  })

  const followConversation = useCallback(() => {
    const viewport = scroll.current
    const messages = content.current
    const space = answerSpace.current
    if (!viewport || !messages || !space) return
    const anchor = turnAnchor.current
      ? Array.from(messages.querySelectorAll<HTMLElement>('[data-assistant-user-message]')).find(
          (element) => element.dataset.assistantUserMessage === turnAnchor.current
        )
      : undefined
    const reserved = anchor
      ? Math.max(
          0,
          Math.round(
            viewport.clientHeight -
              24 -
              (messages.getBoundingClientRect().bottom -
                anchor.getBoundingClientRect().top -
                space.getBoundingClientRect().height)
          )
        )
      : 0
    const height = `${reserved}px`
    if (space.style.height !== height) space.style.height = height
    if (follow.current) {
      if (animateNextScroll.current) {
        animateNextScroll.current = false
        const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
        scrollingToTurn.current =
          smooth && Math.abs(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop) > 1
        viewport.scrollTo({ top: viewport.scrollHeight, behavior: smooth ? 'smooth' : 'instant' })
      } else if (!scrollingToTurn.current) {
        viewport.scrollTop = viewport.scrollHeight
      }
    }
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: Message commits require scroll alignment; keystrokes do not.
  useLayoutEffect(followConversation, [conversation, localMessages, followConversation])

  useEffect(() => {
    const viewport = scroll.current
    const messages = content.current
    if (!viewport || !messages) return
    let frame: number | null = null
    // The answer spacer resizes messages too; write its height outside observer delivery.
    const observer = new ResizeObserver(() => {
      if (frame !== null) return
      frame = window.requestAnimationFrame(() => {
        frame = null
        followConversation()
      })
    })
    observer.observe(messages)
    observer.observe(viewport)
    return () => {
      observer.disconnect()
      if (frame !== null) window.cancelAnimationFrame(frame)
    }
  }, [followConversation])

  const run = useCallback(
    async (retry?: string, localRetry?: LocalMessage) => {
      const retryId = retry ?? (hostResultNeedsCheck ? hostJob?.messageId : undefined)
      const checkingHost = Boolean(retryId && retryId === hostJob?.messageId)
      if (!bridge || actionLock.current || pending || queueEdit || !canUseAgent) return
      if (localRetry && !commandMode && (localRetry.mode !== undefined || localRetry.queued)) {
        restoreLocalDraft(localRetry)
        return
      }
      if (activeTaskAction && (!sharedTaskChat || (!retryId && taskDraft))) return
      if (
        retryId &&
        conversation?.messages.some((message) => message.id === retryId && (message.taskAction || message.command))
      )
        return
      if (
        !retryId &&
        ((taskActionsEnabled && !sharedTaskChat && !taskDraft) || (taskId && (!taskDraft || taskLoading || taskError)))
      )
        return
      if (
        checkingHost
          ? !canCheckHost
          : !canSend ||
            (busy && !queueing) ||
            unfinishedHostJob ||
            hostResultNeedsCheck ||
            (!retryId && (!(localRetry?.text ?? draft).trim() || recoveryRequired))
      )
        return
      const text = localRetry?.text ?? draft
      const optimistic = !retryId && !taskDraft
      const submission: LocalMessage | undefined = optimistic
        ? {
            id: localRetry?.id ?? crypto.randomUUID(),
            text,
            provider: localRetry?.provider ?? (sharedTaskChat || commandMode ? 'codex' : provider),
            mode: localRetry ? localRetry.mode : commandMode ? mode : undefined,
            createdAt: localRetry?.createdAt ?? Date.now(),
            queued: localRetry?.queued ?? queueing,
            failed: false,
          }
        : undefined
      if (submission) {
        const submissions = [...localMessages.filter((message) => message.id !== submission.id), submission]
        if (submissions.length > ASSISTANT_OUTBOX_LIMIT) {
          setActionError({ message: t('Controleer eerst je onbevestigde berichten voordat je verdergaat.') })
          return
        }
        if (
          !sessionReadable.current ||
          !writeAssistantSession(
            assistantSession(localRetry ? drafts : { ...drafts, [draftScope]: '' }, submissions, queueEdit)
          )
        ) {
          setSessionError(true)
          return
        }
      }
      actionLock.current = true
      setPending(true)
      setActionError(null)
      const sendRead = ++conversationRead.current
      if (submission) {
        if (!submission.queued) {
          turnAnchor.current = submission.id
          animateNextScroll.current = true
        }
        setLocalMessages((current) => [...current.filter((message) => message.id !== submission.id), submission])
        if (!localRetry) setDraft('')
        follow.current = true
        setAwayFromBottom(false)
        composer.current?.focus({ preventScroll: true })
      }
      try {
        const value = retryId
          ? await bridge.retryAssistantMessage(retryId)
          : await bridge.sendAssistantMessage({
              text,
              ...(submission ? { clientMessageId: submission.id } : {}),
              ...((submission ? submission.queued : queueing) ? { queue: true } : {}),
              provider: submission?.provider ?? (taskDraft || sharedTaskChat || commandMode ? 'codex' : provider),
              ...(taskDraft
                ? { task: { token: taskDraft.token } }
                : submission
                  ? submission.mode
                    ? { mode: submission.mode }
                    : {}
                  : commandMode
                    ? { mode }
                    : {}),
            })
        if (sendRead === conversationRead.current) setConversation(value)
        if (!submission) {
          follow.current = true
        }
        if (!retryId && !submission) {
          setDraft((current) => (current === text ? '' : current))
          if (taskDraft) {
            setTaskDraft(null)
            router.replace('/assistant/')
          }
        }
      } catch (cause) {
        if (submission) {
          setLocalMessages((current) =>
            current.map((message) => (message.id === submission.id ? { ...message, failed: true } : message))
          )
          // The transport may fail after acceptance. Reconcile before offering a retry with the same ID.
          try {
            const recoveryRead = ++conversationRead.current
            const current = await bridge.getAssistantConversation()
            if (recoveryRead === conversationRead.current) setConversation(current)
            if (containsSubmission(current, submission.id)) return
          } catch {}
          return
        }
        const message = cause instanceof Error ? cause.message : ''
        if (message.includes('host-task-action-busy')) {
          setActionError({ message: t('Er staat nog een opdracht open. Controleer of stop die eerst.') })
          return
        }
        if (
          [
            'assistant-command-effect-slot-occupied',
            'initiative-effect-slot-occupied',
            'assistant-command-recovery-required',
          ].some((code) => message.includes(code))
        ) {
          setActionError({ message: t('Je agent heeft nog werk open. Je concept blijft bewaard.') })
          return
        }
        if (taskDraft && /host-task-draft-(stale|expired)/.test(message)) {
          setTaskError(t('Deze taak is gewijzigd. Controleer de nieuwste versie voordat je verstuurt.'))
          return
        }
        setActionError({
          message: checkingHost
            ? t('De status kon niet worden gecontroleerd. Probeer opnieuw.')
            : t('Het bericht kon niet worden verstuurd. Controleer je agentverbinding.'),
        })
      } finally {
        actionLock.current = false
        setPending(false)
      }
    },
    [
      bridge,
      activeTaskAction,
      taskActionsEnabled,
      sharedTaskChat,
      conversation,
      taskId,
      taskDraft,
      taskLoading,
      taskError,
      router,
      busy,
      queueing,
      pending,
      canUseAgent,
      canSend,
      draft,
      drafts,
      draftScope,
      queueEdit,
      setDraft,
      provider,
      restoreLocalDraft,
      localMessages,
      commandMode,
      mode,
      recoveryRequired,
      hostJob,
      unfinishedHostJob,
      hostResultNeedsCheck,
      canCheckHost,
      setConversation,
      t,
    ]
  )

  async function controlTask(action: AssistantTaskAction, command: 'check' | 'stop' | 'cancel') {
    const lock = sharedTaskChat ? taskActionLock : actionLock
    if (!bridge || lock.current || !action.allowedControls.includes(command)) return
    lock.current = true
    setTaskPending(action.actionId)
    setTaskActionError(null)
    try {
      setConversation(
        await bridge.controlAssistantTask({ actionId: action.actionId, messageId: action.messageId, command })
      )
    } catch {
      setTaskActionError({
        actionId: action.actionId,
        message:
          command === 'stop'
            ? t('Stoppen is nog niet bevestigd.')
            : command === 'cancel'
              ? t('Annuleren is nog niet bevestigd. Controleer de status.')
              : t('De status kon niet worden gecontroleerd. Probeer opnieuw.'),
      })
    } finally {
      lock.current = false
      setTaskPending(null)
    }
  }

  async function stop() {
    if (!bridge || actionLock.current) return
    if (sharedTaskChat ? !activeId && !recoveryRequired && !unfinishedHostJob : taskActionsEnabled || activeTaskAction)
      return
    const stoppingHost = unfinishedHostJob ? hostJob : undefined
    actionLock.current = true
    setPending(true)
    setStoppingId(interactionId ?? null)
    setActionError(null)
    try {
      await bridge.cancelAssistantTurn()
    } catch {
      setActionError({
        message: stoppingHost
          ? t('Stoppen is nog niet bevestigd.')
          : t('De agent kon niet worden gestopt. Probeer het opnieuw.'),
        ...(stoppingHost ? { hostStopMessageId: stoppingHost.messageId } : {}),
      })
    } finally {
      actionLock.current = false
      setStoppingId(null)
      setPending(false)
    }
  }

  async function stopCommand(messageId: string) {
    const command = conversation?.messages.find((message) => message.id === messageId)?.command
    if (
      !bridge ||
      actionLock.current ||
      !command?.canStop ||
      ['completed', 'stopped', 'cancelled'].includes(command.state)
    )
      return
    actionLock.current = true
    setPending(true)
    setStoppingId(messageId)
    setCommandError(null)
    try {
      await bridge.cancelAssistantTurn(messageId)
    } catch {
      setCommandError({ messageId, message: t('Stoppen is nog niet bevestigd.') })
    } finally {
      actionLock.current = false
      setStoppingId(null)
      setPending(false)
    }
  }

  async function controlQueued(messageId: string, action: 'send' | 'edit' | 'discard') {
    if (!bridge || actionLock.current || queueEdit) return
    const queued = conversation?.queuedMessages?.find((message) => message.id === messageId)
    if (!queued || (action === 'edit' && (draft.trim() || drafts['']?.trim()))) return
    const edit = action === 'edit' ? { id: queued.id, text: queued.text } : undefined
    if (edit) {
      if (!sessionReadable.current || !writeAssistantSession(assistantSession(drafts, localMessages, edit))) {
        setSessionError(true)
        return
      }
      setQueueEdit(edit)
    }
    actionLock.current = true
    setPending(true)
    setActionError(null)
    const read = ++conversationRead.current
    try {
      if (action === 'send') {
        const value = await bridge.sendAssistantQueuedMessage({
          queuedMessageId: messageId,
          interruptMessageId: unfinishedCommand?.id,
        })
        if (read === conversationRead.current) {
          if (value.messages.some((message) => message.role === 'user' && message.id === messageId)) {
            turnAnchor.current = messageId
            animateNextScroll.current = true
            follow.current = true
            setAwayFromBottom(false)
          }
          setConversation(value)
        }
      } else {
        await bridge.cancelAssistantTurn(messageId)
        if (edit) {
          finishQueueEdit(edit)
          setPage((current) => ({ ...current }))
          return
        }
        const value = await bridge.getAssistantConversation()
        if (read === conversationRead.current) setConversation(value)
      }
    } catch {
      setActionError({
        message: t('De wijziging is nog niet bevestigd. Controleer de wachtrij voordat je verdergaat.'),
      })
      try {
        const recoveryRead = ++conversationRead.current
        const value = await bridge.getAssistantConversation()
        if (recoveryRead === conversationRead.current) setConversation(value)
        if (edit) reconcileQueueEdit(value, edit)
      } catch {}
    } finally {
      actionLock.current = false
      setPending(false)
    }
  }

  function finishQueueEdit(edit: NonNullable<AssistantSession['queueEdit']>) {
    setDrafts((current) => ({ ...current, '': edit.text }))
    setQueueEdit(undefined)
    setActionError(null)
    router.replace('/assistant/')
    composer.current?.focus({ preventScroll: true })
  }

  function reconcileQueueEdit(value: AssistantConversation, edit: NonNullable<AssistantSession['queueEdit']>) {
    if (value.queuedMessages?.some((message) => message.id === edit.id)) return
    if (value.messages.some((message) => message.id === edit.id)) {
      setQueueEdit(undefined)
      setActionError({ message: t('Dit bericht is al verstuurd. Je vindt het terug in het gesprek.') })
    }
  }

  async function recoverQueueEdit() {
    if (!bridge || !queueEdit || actionLock.current) return
    actionLock.current = true
    setPending(true)
    try {
      await bridge.cancelAssistantTurn(queueEdit.id)
      finishQueueEdit(queueEdit)
      setPage((current) => ({ ...current }))
    } catch (cause) {
      if (cause instanceof Error && cause.message.includes('assistant-queue-already-sent')) {
        setQueueEdit(undefined)
        setActionError({ message: t('Dit bericht is al verstuurd. Je vindt het terug in het gesprek.') })
        return
      }
      setActionError({ message: t('Bewerken is nog niet bevestigd. Je tekst blijft bewaard.') })
      try {
        const read = ++conversationRead.current
        const value = await bridge.getAssistantConversation()
        if (read === conversationRead.current) setConversation(value)
        reconcileQueueEdit(value, queueEdit)
      } catch {}
    } finally {
      actionLock.current = false
      setPending(false)
    }
  }

  function recoverSession() {
    if (sessionReadable.current) {
      setSessionError(!writeAssistantSession(assistantSession(drafts, localMessages, queueEdit)))
      return
    }
    const saved = readAssistantSession()
    if (!saved) return
    sessionReadable.current = true
    setDrafts((current) => ({ ...current, ...saved.scopedDrafts, '': saved.draft }))
    setLocalMessages(saved.submissions)
    setQueueEdit(saved.queueEdit)
    setSessionError(false)
  }

  return (
    <div data-assistant-empty={emptyChat} className="relative flex h-full min-h-0 flex-col">
      <h1 className="sr-only">{t('Agent')}</h1>
      <div
        ref={scroll}
        data-assistant-scroll
        onScrollEnd={() => {
          scrollingToTurn.current = false
        }}
        onWheel={() => {
          scrollingToTurn.current = false
          follow.current = false
        }}
        onPointerDown={() => {
          scrollingToTurn.current = false
          follow.current = false
        }}
        onKeyDown={(event) => {
          if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key)) {
            scrollingToTurn.current = false
            follow.current = false
          }
        }}
        onScroll={() => {
          markVisibleRead()
          if (scrollingToTurn.current) return
          const element = scroll.current
          if (element) {
            const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 48
            follow.current = atBottom
            setAwayFromBottom(!atBottom)
            if (element.scrollTop < 160 && !atBottom && !earlierError) void loadEarlier()
          }
        }}
        className={
          emptyChat
            ? 'hidden'
            : 'custom-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain [overflow-anchor:none]'
        }
        style={{ scrollbarGutter: 'stable both-edges' }}
      >
        <div ref={content} data-assistant-content className="mx-auto w-full max-w-[782px] px-4 py-9">
          {!conversation && !error ? (
            <div role="status" className="flex min-h-40 items-center justify-center gap-2 text-slate-500 text-sm">
              <Spinner size="xs" />
              {t('Gesprek laden')}
            </div>
          ) : null}
          {conversation?.hasEarlier ? (
            <div
              role="status"
              className="flex h-8 items-center justify-center text-slate-500"
              aria-label={loadingEarlier ? t('Gesprek laden') : undefined}
            >
              {loadingEarlier ? <Spinner size="xs" /> : null}
            </div>
          ) : null}
          {earlierError ? (
            <Button size="small" variant="text" color="secondary" onClick={() => void loadEarlier()}>
              {t('Opnieuw proberen')}
            </Button>
          ) : null}
          <div className="space-y-6">
            {conversation?.messages.map((message, index) => (
              <AssistantMessageView
                key={message.id}
                onConversationChanged={setConversation}
                message={message}
                now={now}
                previousMessage={conversation.messages[index - 1]}
                hostJob={hostJob?.messageId === message.id ? hostJob : undefined}
                hasCurrentReview={visibleRequests.some((request) => request.turnId === message.id)}
                sharedTaskChat={sharedTaskChat}
                unifiedCommand={commandMode?.unified}
                commandPending={pending}
                stopping={stoppingId === message.id}
                commandError={commandError?.messageId === message.id ? commandError.message : undefined}
                onCommandStop={() => void stopCommand(message.id)}
                onCommandFocus={(element) => retainControlFocus(element, message.id)}
                taskPending={taskPending !== null || (!sharedTaskChat && pending)}
                taskError={
                  taskActionError?.actionId === message.taskAction?.actionId ? taskActionError?.message : undefined
                }
                onTaskControl={(command) => {
                  if (message.taskAction) void controlTask(message.taskAction, command)
                }}
                busy={
                  hostJob?.messageId === message.id
                    ? pending || Boolean(queueEdit) || !canUseAgent
                    : busy ||
                      unfinishedHostJob ||
                      hostResultNeedsCheck ||
                      !canSend ||
                      (sharedTaskChat && recoveryRequired) ||
                      (recoveryRequired && message.id !== conversation.remoteRecoveryMessageId)
                }
                onRetry={() => void run(message.id)}
                onCheckFocus={retainControlFocus}
              />
            ))}
            {unconfirmedMessages
              .filter((message) => !message.queued || message.failed)
              .map((message) => (
                <div key={message.id} data-assistant-local-message={message.id} className="space-y-6">
                  <div
                    data-assistant-user-message={message.id}
                    className="ml-auto w-fit max-w-[88%] whitespace-pre-wrap break-words rounded-2xl bg-slate-100 px-3.5 py-2.5 text-slate-900 text-ui leading-6"
                  >
                    {message.text}
                  </div>
                  {message.failed ? (
                    <div role="alert" className="flex flex-wrap items-center gap-2 text-slate-500 text-sm">
                      <span>{t('Verzenden niet bevestigd. Je bericht blijft bewaard.')}</span>
                      <Button
                        size="small"
                        variant="text"
                        color="secondary"
                        disabled={busy || !canSend}
                        onClick={() => void run(undefined, message)}
                      >
                        {t('Opnieuw proberen')}
                      </Button>
                    </div>
                  ) : !activeId && !unfinishedCommand ? (
                    <div>
                      <AssistantProgress active steps={[]} startedAt={message.createdAt} />
                    </div>
                  ) : null}
                </div>
              ))}
          </div>
          <AgentWorkerControls
            requests={visibleRequests}
            error={
              activeTaskAction
                ? taskReviewReady
                  ? interactionError
                  : ''
                : !hostJob || hostReviewReady
                  ? interactionError
                  : ''
            }
            onRefresh={async () => {
              const read = interactionReader.current
              if (!read) throw new Error('agent-interaction-read-unavailable')
              return read()
            }}
            onFocusCapture={(event) => {
              if (event.target instanceof HTMLElement) retainControlFocus(event.target)
            }}
          />
          <div ref={answerSpace} aria-hidden="true" data-assistant-answer-space />
        </div>
      </div>
      <div className={emptyChat ? 'relative my-auto w-full shrink-0' : 'relative w-full shrink-0'}>
        {awayFromBottom ? (
          <Button
            size="small"
            variant="solid"
            color="secondary"
            radius="full"
            className="absolute -top-12 left-1/2 size-8 -translate-x-1/2 p-0 shadow-raised"
            aria-label={t('Naar nieuwste bericht')}
            onClick={() => {
              follow.current = true
              if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight
              setAwayFromBottom(false)
            }}
          >
            <IconArrowDown className="size-4" aria-hidden="true" />
          </Button>
        ) : null}
        <div className="custom-scrollbar -my-3 overflow-y-hidden py-3" style={{ scrollbarGutter: 'stable both-edges' }}>
          <div
            className={
              emptyChat ? 'mx-auto w-full max-w-[782px] px-4 pb-[8vh]' : 'mx-auto w-full max-w-[782px] px-4 pb-3'
            }
          >
            {error ? (
              <div role="alert" className="mb-3 flex flex-wrap items-center gap-2 text-danger-700 text-sm">
                <span>{error}</span>
                {sessionError ? (
                  <Button size="small" variant="text" color="secondary" onClick={recoverSession}>
                    {t('Opnieuw proberen')}
                  </Button>
                ) : !conversation ? (
                  <Button
                    size="small"
                    variant="text"
                    color="secondary"
                    onClick={() => setPage((current) => ({ ...current }))}
                  >
                    {t('Opnieuw proberen')}
                  </Button>
                ) : !visibleActionError?.hostStopMessageId ? (
                  <Link href="/agent/" className="underline">
                    {t('Instellingen')}
                  </Link>
                ) : null}
              </div>
            ) : null}
            {settings?.offlineMode ? (
              <p role="status" className="mb-3 text-slate-500 text-sm">
                {t('Je bent offline. Je gesprek blijft bewaard.')}
              </p>
            ) : null}
            {recoveryRequired && !activeId && !hostJob && !unfinishedCommand ? (
              <p role="status" className="mb-3 text-slate-600 text-sm leading-5">
                {sharedTaskChat
                  ? t('Er staat nog een oudere opdracht open. Stop die eerst om verder te chatten.')
                  : t(
                      'De verbinding is onderbroken. Controleer de bestaande opdracht met Opnieuw proberen, of stop deze eerst. Er wordt niets automatisch opnieuw uitgevoerd.'
                    )}
              </p>
            ) : null}
            {activeTaskAction &&
            !conversation?.messages.some((message) => message.id === activeTaskAction.messageId) ? (
              <div className="mb-3">
                {sharedTaskChat ? <p className="text-slate-500 text-xs">{t('Opdracht · agentcomputer')}</p> : null}
                <AssistantTaskStatus
                  action={activeTaskAction}
                  hasCurrentReview={visibleRequests.length > 0}
                  pending={taskPending !== null || (!sharedTaskChat && pending)}
                  error={taskActionError?.actionId === activeTaskAction.actionId ? taskActionError.message : undefined}
                  onControl={(command) => void controlTask(activeTaskAction, command)}
                  onFocus={retainControlFocus}
                  t={t}
                />
              </div>
            ) : null}
            {taskActionsEnabled && !sharedTaskChat && !taskId && !activeTaskAction ? (
              <p className="mb-3 text-slate-500 text-sm">
                <Link
                  href="/inbox/"
                  className="rounded underline outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
                >
                  {t('Open een taak om een opdracht te maken.')}
                </Link>
              </p>
            ) : null}
            {taskId ? (
              <div className="mb-3 text-sm" data-assistant-task-draft={taskDraft?.workItemId ?? taskId}>
                <div className="flex min-w-0 items-center justify-between gap-2">
                  {taskDraft ? (
                    <p className="min-w-0 truncate font-medium text-slate-800">
                      {t('Taak')}: {taskDraft.title}
                    </p>
                  ) : (
                    <span />
                  )}
                  {sharedTaskChat ? (
                    <Button
                      size="small"
                      variant="text"
                      color="secondary"
                      className="pointer-coarse:min-h-11"
                      aria-label={t('Taak uit concept verwijderen')}
                      disabled={pending}
                      onClick={() => {
                        taskRead.current += 1
                        setTaskDraft(null)
                        setTaskError('')
                        setTaskLoading(false)
                        router.replace('/assistant/')
                        composer.current?.focus()
                      }}
                    >
                      {t('Terug naar gesprek')}
                    </Button>
                  ) : null}
                </div>
                {taskDraft ? (
                  <Link
                    href={wikiPageHref(taskDraft.source.spaceId, taskDraft.source.slug)}
                    aria-label={`${t('Openen')}: Personal · ${taskDraft.source.title} (${taskDraft.source.slug})`}
                    title={taskDraft.source.slug}
                    className="mt-1 block truncate rounded text-slate-500 underline decoration-slate-300 underline-offset-2 outline-none hover:text-slate-800 focus-visible:ring-2 focus-visible:ring-slate-400"
                  >
                    Personal · {taskDraft.source.title}
                  </Link>
                ) : null}
                {sharedTaskChat && activeTaskAction ? (
                  <p role="status" className="mt-1 text-slate-500">
                    {t('Er staat nog een opdracht open. Dit concept wordt niet automatisch verstuurd.')}
                  </p>
                ) : null}
                {taskLoading || !conversation ? (
                  <p role="status" className="flex items-center gap-2 text-slate-500">
                    <Spinner size="xs" />
                    {t('Taak laden…')}
                  </p>
                ) : null}
                {conversation && !taskActionsEnabled ? (
                  <p role="status" className="text-slate-500">
                    {t('Taken openen in Agent is hier niet beschikbaar.')}
                  </p>
                ) : null}
                {taskError ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <p role="alert" className="text-danger-700">
                      {taskError}
                    </p>
                    <Button
                      size="small"
                      variant="text"
                      color="secondary"
                      disabled={taskLoading || pending}
                      onClick={() => void loadTaskDraft(true)}
                    >
                      {t('Taak vernieuwen')}
                    </Button>
                  </div>
                ) : null}
              </div>
            ) : null}
            {conversation?.queuedMessages?.length ? (
              <div className="mb-2 space-y-1" aria-label={t('Wachtrij')}>
                {conversation.queuedMessages.map((message) => (
                  <div
                    key={message.id}
                    data-assistant-queued-message={message.id}
                    className="flex flex-wrap items-center gap-2 px-1 text-sm text-slate-500"
                  >
                    <span className="shrink-0">{message.state === 'waiting' ? t('In wachtrij') : t('Gepauzeerd')}</span>
                    <span className="min-w-24 flex-1 truncate" title={message.text}>
                      {message.text}
                    </span>
                    <Button
                      size="small"
                      variant="text"
                      color="secondary"
                      disabled={
                        pending ||
                        Boolean(queueEdit) ||
                        !canSend ||
                        (Boolean(unfinishedCommand) && !unfinishedCommand?.command?.canStop)
                      }
                      onClick={() => void controlQueued(message.id, 'send')}
                    >
                      {t('Nu versturen')}
                    </Button>
                    <Button
                      size="small"
                      variant="text"
                      color="secondary"
                      disabled={pending || Boolean(queueEdit) || Boolean(draft.trim() || drafts['']?.trim())}
                      onClick={() => void controlQueued(message.id, 'edit')}
                    >
                      {t('Bewerken')}
                    </Button>
                    <Button
                      size="small"
                      variant="text"
                      color="secondary"
                      disabled={pending || Boolean(queueEdit)}
                      onClick={() => void controlQueued(message.id, 'discard')}
                    >
                      {t('Verwijderen')}
                    </Button>
                  </div>
                ))}
              </div>
            ) : null}
            {unconfirmedMessages
              .filter((message) => message.queued && !message.failed)
              .map((message) => (
                <p
                  key={message.id}
                  data-assistant-local-message={message.id}
                  role="status"
                  className="mb-2 truncate px-1 text-slate-500 text-sm"
                >
                  {t('In wachtrij')} · {message.text}
                </p>
              ))}
            {queueEdit ? (
              <div role="status" className="mb-2 flex items-center gap-2 text-slate-500 text-sm">
                <span className="min-w-0 flex-1 truncate" title={queueEdit.text}>
                  {t('Bewerken is nog niet bevestigd. Je tekst blijft bewaard.')}
                </span>
                <Button
                  size="small"
                  variant="text"
                  color="secondary"
                  disabled={pending}
                  onClick={() => void recoverQueueEdit()}
                >
                  {t('Opnieuw proberen')}
                </Button>
              </div>
            ) : null}
            {conversation?.briefingsEnabled ? (
              <div className="mb-2 flex justify-end">
                <AssistantBriefingGrant conversation={conversation} onChanged={setConversation} />
              </div>
            ) : null}
            {emptyChat ? (
              <h2 className="mb-6 text-center font-medium text-lg tracking-tight text-slate-900">
                {t('Wat houdt je bezig?')}
              </h2>
            ) : null}
            <motion.form
              layout={reducedMotion ? false : 'position'}
              layoutDependency={emptyChat}
              initial={false}
              transition={{ layout: { duration: 0.24, ease: [0.4, 0, 0.2, 1] } }}
              data-assistant-composer
              onSubmit={(event) => {
                event.preventDefault()
                if (dictating) return
                if (queueing && !draft.trim() && unfinishedCommand) void stopCommand(unfinishedCommand.id)
                else void run()
              }}
              className="rounded-2xl border border-slate-300 bg-white p-2 shadow-[0_4px_20px_0_rgb(0_0_0/0.04)] focus-within:border-slate-400"
            >
              <label htmlFor="assistant-message" className="sr-only">
                {t('Bericht aan de agent')}
              </label>
              <div className={emptyChat ? 'relative flex min-h-[86px] items-end gap-2' : 'flex items-end gap-2'}>
                <textarea
                  id="assistant-message"
                  ref={composer}
                  value={draft}
                  readOnly={Boolean(queueEdit) || !sessionReadable.current}
                  onChange={(event) => {
                    setDraft(event.target.value)
                    updateComposing(Boolean(event.target.value.trim()))
                  }}
                  onFocus={() => updateComposing(Boolean(draftValue.current.trim()))}
                  onBlur={() => updateComposing(false)}
                  maxLength={20_000}
                  rows={1}
                  placeholder={t('Schrijf een bericht…')}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault()
                      if (!dictating) void run()
                    }
                  }}
                  className={`block max-h-44 min-h-7 min-w-0 flex-1 resize-none bg-transparent px-1.5 py-1 text-base text-slate-900 leading-6 outline-none placeholder:text-slate-400 [field-sizing:content] ${emptyChat ? 'self-start pb-10' : ''}`}
                />
                <ComposerDictation
                  disabled={Boolean(queueEdit) || !sessionReadable.current}
                  onBusyChange={setDictating}
                  onTranscript={(text) => {
                    const current = draftsRef.current[draftScope] ?? ''
                    const next = `${current}${current && !/\s$/.test(current) ? ' ' : ''}${text}`
                    if (next.length > 20_000) return false
                    setDrafts((drafts) => ({ ...drafts, [draftScope]: next }))
                    if (!composer.current?.closest('[hidden]')) composer.current?.focus()
                    return true
                  }}
                />
                {commandMode?.unified && unfinishedCommand ? (
                  <Button
                    size="small"
                    variant="solid"
                    color="secondary"
                    radius="full"
                    className="size-8 p-0"
                    aria-label={t('Stoppen')}
                    title={t('Stoppen')}
                    disabled={pending || !unfinishedCommand.command?.canStop}
                    onFocus={(event) => retainControlFocus(event.currentTarget, unfinishedCommand.id)}
                    onClick={() => void stopCommand(unfinishedCommand.id)}
                  >
                    <IconStop className="size-3.5" aria-hidden="true" />
                  </Button>
                ) : !unfinishedCommand &&
                  (sharedTaskChat
                    ? activeId || recoveryRequired || unfinishedHostJob
                    : !taskActionsEnabled && (activeId || recoveryRequired || unfinishedHostJob)) ? (
                  <Button
                    key={`stop:${(sharedTaskChat ? activeId : interactionId) ?? 'current'}`}
                    size="small"
                    variant="solid"
                    color="secondary"
                    radius="full"
                    className="size-8 p-0"
                    disabled={pending}
                    aria-label={sharedTaskChat && activeId ? t('Antwoord stoppen') : t('Stoppen')}
                    title={t('Stoppen')}
                    onFocus={(event) => retainControlFocus(event.currentTarget)}
                    onClick={() => void stop()}
                  >
                    <IconStop className="size-3.5" aria-hidden="true" />
                  </Button>
                ) : null}
                {!showStop || (queueing && draft.trim()) ? (
                  <Button
                    size="small"
                    variant="solid"
                    color="secondary"
                    radius="full"
                    className="size-8 p-0"
                    aria-label={queueing ? t('Bericht in wachtrij') : t('Versturen')}
                    title={queueing ? t('Bericht in wachtrij') : t('Versturen')}
                    type="submit"
                    key="send"
                    disabled={
                      (taskActionsEnabled && !sharedTaskChat && !taskDraft) ||
                      (Boolean(taskDraft) && Boolean(activeTaskAction)) ||
                      (busy && !queueing) ||
                      pending ||
                      Boolean(queueEdit) ||
                      (!sharedTaskChat && taskPending !== null) ||
                      unfinishedHostJob ||
                      hostResultNeedsCheck ||
                      dictating ||
                      !draft.trim() ||
                      !canSend ||
                      recoveryRequired ||
                      Boolean(taskId && (!taskDraft || taskLoading || taskError))
                    }
                  >
                    {pending ? <Spinner size="xs" /> : <IconArrowUp className="size-4" aria-hidden="true" />}
                  </Button>
                ) : null}
              </div>
            </motion.form>
            <div className="flex items-center justify-end px-2">
              {commandMode && !taskId && !taskDraft ? (
                commandMode.unified ? null : (
                  <div className="mt-2 px-1">
                    <AssistantCommandMode value={mode} onChange={setMode} disabled={pending} />
                  </div>
                )
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
})

const AssistantAnswer = memo(function AssistantAnswer({
  text,
  results,
  initiative,
  status,
}: Pick<AssistantMessage, 'text' | 'results' | 'initiative' | 'status'>) {
  const [animateWords] = useState(status === 'streaming')
  return (
    <MarkdownContent
      rehypePlugins={[[rehypeStreamingWords, { enabled: animateWords }]]}
      components={{ pre: AssistantCodeBlock, a: AssistantMarkdownLink }}
      remarkPlugins={[
        [
          remarkAssistantReferences,
          {
            exclude: [
              ...(results?.map((result) => wikiPageHref(result.spaceId, result.slug)) ?? []),
              ...(initiative?.taskIds?.map((id) => `/inbox/?item=${encodeURIComponent(id)}`) ?? []),
            ],
          },
        ],
      ]}
      className="break-words [overflow-wrap:anywhere] [&_hr]:border-t-[0.5px] [&_hr]:border-slate-200"
    >
      {text}
    </MarkdownContent>
  )
})

function AssistantMessageView({
  message,
  now,
  previousMessage,
  hostJob,
  hasCurrentReview,
  busy,
  onRetry,
  onCheckFocus,
  taskPending,
  taskError,
  onTaskControl,
  sharedTaskChat,
  onConversationChanged,
  unifiedCommand,
  commandPending,
  commandError,
  onCommandStop,
  onCommandFocus,
  stopping,
}: {
  onConversationChanged: (conversation: AssistantConversation) => void
  message: AssistantMessage
  now: number
  previousMessage?: AssistantMessage
  hostJob?: AssistantConversation['hostJob']
  hasCurrentReview: boolean
  busy: boolean
  onRetry: () => void
  taskPending: boolean
  taskError?: string
  onTaskControl: (command: 'check' | 'stop' | 'cancel') => void
  onCheckFocus: (element: HTMLButtonElement) => void
  sharedTaskChat?: boolean
  unifiedCommand?: boolean
  commandPending: boolean
  commandError?: string
  onCommandStop: () => void
  onCommandFocus: (element: HTMLButtonElement) => void
  stopping: boolean
}) {
  const { t, dateLocale } = useI18n()
  if (message.role === 'user')
    return (
      <div
        data-assistant-user-message={message.id}
        className="ml-auto w-fit max-w-[88%] whitespace-pre-wrap break-words rounded-2xl bg-slate-100 px-3.5 py-2.5 text-slate-900 text-ui leading-6"
      >
        {message.text}
      </div>
    )
  const incomplete = ['failed', 'cancelled', 'interrupted'].includes(message.status)
  const waitExpired = message.status === 'cancelled' && message.error === 'assistant-host-request-expired'
  const contextChanged = message.status === 'cancelled' && message.error === 'assistant-host-context-invalidated'
  const retiredRemote = message.error?.startsWith('assistant-remote-retired') === true
  const retiredUnknown = retiredRemote && message.status !== 'cancelled'
  const status = retiredUnknown
    ? t('Eerdere externe opdracht. Uitkomst onbekend; niet opnieuw gestart.')
    : waitExpired
      ? t('Gestopt: wachttijd verlopen.')
      : contextChanged
        ? t('Gestopt: informatie of toegang gewijzigd.')
        : message.error?.startsWith('codex-remote-')
          ? t('De opdracht op je agentcomputer moet opnieuw worden gecontroleerd.')
          : message.status === 'cancelled'
            ? t('Gestopt')
            : message.status === 'interrupted'
              ? t('Onderbroken bij het afsluiten van Remember.')
              : t('De agent kon dit antwoord niet afronden.')
  return (
    <article
      aria-label={t('Antwoord van je agent')}
      data-assistant-message={message.id}
      className="group/message relative min-w-0"
    >
      {previousMessage?.role === 'assistant' ? (
        <div className="mb-6 flex items-center gap-3 text-slate-400 text-xs" data-assistant-message-divider>
          <span aria-hidden="true" className="h-[0.5px] flex-1 bg-slate-200" />
          <time
            dateTime={new Date(message.createdAt).toISOString()}
            title={new Date(message.createdAt).toLocaleString(dateLocale)}
            className="shrink-0 tabular-nums"
          >
            {formatAssistantTimestamp(message.createdAt, dateLocale, now)}
          </time>
          <span aria-hidden="true" className="h-[0.5px] flex-1 bg-slate-200" />
        </div>
      ) : null}
      {message.error === 'assistant-proactive-source-unavailable' ? (
        <p className="text-slate-500 text-sm">{t('De bron is niet meer beschikbaar.')}</p>
      ) : null}
      {!hostJob && !message.taskAction && !message.briefingAction ? (
        <AssistantProgress
          steps={message.steps}
          active={
            !stopping &&
            !hasCurrentReview &&
            (message.command
              ? ['reserved', 'dispatching', 'running'].includes(message.command.state) && !message.command.stopRequested
              : message.status === 'streaming')
          }
          startedAt={message.createdAt}
          hasResponse={Boolean(message.text)}
          label={
            stopping
              ? t('Stoppen…')
              : hasCurrentReview
                ? t('Wacht op je antwoord')
                : message.command?.state === 'reserved'
                  ? t('Klaargezet, nog niet gestart.')
                  : message.command?.state === 'dispatching'
                    ? t('Start nog niet bevestigd. Er wordt niets opnieuw gestart.')
                    : undefined
          }
        />
      ) : null}
      {message.text ? (
        <AssistantAnswer
          text={message.text}
          results={message.results}
          initiative={message.initiative}
          status={message.status}
        />
      ) : null}
      {message.initiative?.taskIds?.length ? (
        <div className="mt-3 flex flex-wrap">
          {[...new Set(message.initiative.taskIds)].map((id) => (
            <AssistantReferenceCard
              key={id}
              reference={{ kind: 'task', id, href: `/inbox/?item=${encodeURIComponent(id)}` }}
            >
              {t('Taak')}
            </AssistantReferenceCard>
          ))}
        </div>
      ) : null}
      <AssistantSavedResults results={message.results} label={t("Opgeslagen pagina's")} openLabel={t('Openen')} />
      {message.briefingAction ? (
        <AssistantBriefingStatus action={message.briefingAction} onChanged={onConversationChanged} />
      ) : null}
      {message.command &&
      (!unifiedCommand ||
        !['reserved', 'dispatching', 'running'].includes(message.command.state) ||
        message.command.stopRequested) ? (
        <AssistantCommandStatus
          command={message.command}
          unified={unifiedCommand}
          pending={commandPending}
          error={commandError}
          onStop={onCommandStop}
          onFocus={onCommandFocus}
        />
      ) : message.taskAction ? (
        <div>
          {sharedTaskChat ? <p className="mt-3 text-slate-500 text-xs">{t('Opdracht · agentcomputer')}</p> : null}
          <AssistantTaskStatus
            action={message.taskAction}
            hasCurrentReview={hasCurrentReview}
            pending={taskPending}
            error={taskError}
            onControl={onTaskControl}
            onFocus={onCheckFocus}
            t={t}
          />
        </div>
      ) : hostJob ? (
        <HostJobStatus
          hostJob={hostJob}
          messageError={message.error}
          hasCurrentReview={hasCurrentReview}
          busy={busy}
          onCheck={onRetry}
          onCheckFocus={onCheckFocus}
        />
      ) : null}
      {incomplete && !hostJob && !message.taskAction && !message.briefingAction && !message.command ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-slate-500 text-sm">
          {message.status === 'cancelled' ? (
            <IconStop className="size-3 shrink-0" aria-hidden="true" />
          ) : (
            <IconCircleInfo className="size-4 shrink-0" aria-hidden="true" />
          )}
          <span role="status">{status}</span>
          {!retiredRemote && !waitExpired && !contextChanged ? (
            <Button
              size="small"
              variant="text"
              color="secondary"
              className="size-8 p-0"
              aria-label={t('Opnieuw proberen')}
              title={t('Opnieuw proberen')}
              disabled={busy}
              onClick={onRetry}
            >
              <IconArrowRotateClockwise className="size-4" aria-hidden="true" />
            </Button>
          ) : null}
        </div>
      ) : null}
    </article>
  )
}

function HostJobStatus({
  hostJob,
  messageError,
  hasCurrentReview,
  busy,
  onCheck,
  onCheckFocus,
}: {
  hostJob: NonNullable<AssistantConversation['hostJob']>
  messageError?: string | null
  hasCurrentReview: boolean
  busy: boolean
  onCheck: () => void
  onCheckFocus: (element: HTMLButtonElement) => void
}) {
  const { t } = useI18n()
  const { phase, connection, stopRequested, stopReason } = hostJob
  const resultNeedsCheck = phase === 'completed' && messageError === 'assistant-host-context-unavailable'
  if (phase === 'completed' && !resultNeedsCheck) return null
  const stopped = phase === 'stopped'
  const checking = !stopped && connection === 'connecting'
  const working = !stopped && connection === 'connected' && ['starting', 'running'].includes(phase)
  const showCheck = !stopped && (resultNeedsCheck || connection !== 'connected' || phase === 'recovery-required')
  let status = t('Werkt op je agentcomputer.')
  if (resultNeedsCheck) status = t('Resultaat nog niet gecontroleerd. De bronnen zijn tijdelijk niet beschikbaar.')
  else if (stopped)
    status =
      stopReason === 'request-expired'
        ? t('Gestopt: wachttijd verlopen.')
        : stopReason === 'context-invalidated'
          ? t('Gestopt: informatie of toegang gewijzigd.')
          : t('Gestopt')
  else if (stopReason === 'request-expired') status = t('Wachttijd verlopen. Stoppen is nog niet bevestigd.')
  else if (stopRequested && stopReason === 'context-invalidated')
    status = t('Informatie of toegang gewijzigd. Stoppen is nog niet bevestigd.')
  else if (stopRequested)
    status =
      connection === 'connected' && phase !== 'recovery-required' ? t('Stoppen…') : t('Stoppen is nog niet bevestigd.')
  else if (checking) status = t('Verbinding maken…')
  else if (phase === 'starting' && connection === 'disconnected')
    status = t('Start nog niet bevestigd. Er wordt niets opnieuw gestart.')
  else if (phase === 'recovery-required') status = t('De status van deze opdracht is nog niet bevestigd.')
  else if (connection === 'disconnected') status = t('Verbinding onderbroken. Status nog niet gecontroleerd.')
  else if (phase === 'waiting') status = hasCurrentReview ? t('Wacht op je akkoord.') : t('Wacht op Remember.')
  else if (phase === 'starting') status = t('Opdracht starten…')

  return (
    <div className="mt-3 flex min-h-5 flex-wrap items-center gap-2 text-slate-500 text-sm">
      <span role="status" className="flex min-w-0 items-center gap-2">
        {checking || working ? <Spinner size="xs" /> : null}
        <span>{status}</span>
      </span>
      {showCheck ? (
        <Button
          size="small"
          variant="text"
          color="secondary"
          className="pointer-coarse:min-h-11"
          disabled={busy || checking}
          onClick={onCheck}
          onFocus={(event) => onCheckFocus(event.currentTarget)}
        >
          {t('Status controleren')}
        </Button>
      ) : null}
    </div>
  )
}
