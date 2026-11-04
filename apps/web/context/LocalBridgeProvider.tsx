'use client'

import { coalesceRefresh, pollConversationProcessing, reconcileWorkItems } from '@internal/components/localDataRefresh'
import { createWikiCacheAccess, retainWikiPageCache } from '@internal/components/wikiCache'
import { removeWikiDrafts } from '@internal/components/wikiDrafts'
import { installRendererErrorReporting } from '@internal/lib/errorReporting'
import { getRememberBridge } from '@internal/lib/rememberBridge'
import type {
  AgentProvider,
  AgentSetup,
  CaptureState,
  CreateLocalWikiSpaceInput,
  CreateWikiPageInput,
  Day,
  DayChanges,
  DaySnapshot,
  DeleteWikiPageInput,
  KnowledgeSuggestionActionInput,
  LocalSettings,
  MoveWikiProjectInput,
  RememberBridge,
  RemoveLocalWikiSpaceInput,
  ReorderWikiSpacesInput,
  RestoreWikiPageRevisionInput,
  SaveWikiPageInput,
  UpdateState,
  UpdateWikiSpaceInput,
  WikiOverview,
  WikiPage,
  WikiPageHistory,
  WikiPageHistoryInput,
  WorkItem,
} from '@remember/shared'
import { applyDayChanges, PERSONAL_WIKI_SPACE_ID } from '@remember/shared'
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'

type LocalBridgeContextValue = {
  bridge: RememberBridge | null
  ready: boolean
  taskActionsEnabled: boolean | null
  userName: string | null
  state: CaptureState | null
  acceptState: (state: CaptureState) => void
  days: Day[]
  acceptDaySnapshot: (snapshot: DaySnapshot) => void
  workItems: WorkItem[]
  settings: LocalSettings | null
  agent: AgentSetup | null
  agentConnections: Partial<Record<AgentProvider, AgentSetup>>
  refreshAgent: (provider?: AgentProvider) => Promise<void>
  wiki: WikiPage[]
  wikiBySpace: Record<string, WikiPage[]>
  wikiOverview: WikiOverview | null
  bootstrapLoadStatus: LocalDataLoadState
  dataLoadStatus: LocalDataLoadStatus
  activeWikiSpaceId: string
  update: UpdateState
  updateRestartPending: boolean
  refresh: () => Promise<void>
  loadAllWikiPages: () => Promise<void>
  upsertWorkItem: (item: WorkItem) => void
  updateSettings: (patch: Partial<LocalSettings>) => Promise<LocalSettings>
  checkForUpdate: () => Promise<UpdateState>
  downloadUpdate: () => Promise<UpdateState>
  restartToUpdate: () => Promise<void>
  selectWikiSpace: (spaceId: string) => Promise<void>
  registerWikiEditorFlush: (spaceId: string, flush: () => Promise<void>) => () => void
  canAccessWikiSpace: (spaceId: string) => boolean
  createLocalWikiSpace: (input: CreateLocalWikiSpaceInput) => Promise<WikiOverview>
  removeLocalWikiSpace: (input: RemoveLocalWikiSpaceInput) => Promise<WikiOverview>
  updateWikiSpace: (input: UpdateWikiSpaceInput) => Promise<WikiOverview>
  reorderWikiSpaces: (input: ReorderWikiSpacesInput) => Promise<WikiOverview>
  createWikiPage: (input: CreateWikiPageInput) => Promise<WikiPage[]>
  saveWikiPage: (input: SaveWikiPageInput) => Promise<WikiPage[]>
  deleteWikiPage: (input: DeleteWikiPageInput) => Promise<WikiPage[]>
  getWikiPageHistory: (input: WikiPageHistoryInput) => Promise<WikiPageHistory>
  restoreWikiPageRevision: (input: RestoreWikiPageRevisionInput) => Promise<WikiPage[]>
  moveWikiProject: (input: MoveWikiProjectInput) => Promise<WikiOverview>
  applyKnowledgeSuggestion: (input: KnowledgeSuggestionActionInput) => Promise<WikiOverview>
  dismissKnowledgeSuggestion: (input: KnowledgeSuggestionActionInput) => Promise<WikiOverview>
}

type LocalDataResource = 'days' | 'workItems' | 'wiki'
type LocalDataLoadState = 'loading' | 'ready' | 'error'
type LocalDataLoadStatus = Record<LocalDataResource, LocalDataLoadState>

const initialDataLoadStatus: LocalDataLoadStatus = {
  days: 'loading',
  workItems: 'loading',
  wiki: 'loading',
}

const emptyWikiPages: WikiPage[] = []

const LocalBridgeContext = createContext<LocalBridgeContextValue | null>(null)

export function LocalBridgeProvider({ children }: { children: ReactNode }) {
  const bridgeRef = useRef<RememberBridge | null>(null)
  if (typeof window !== 'undefined' && !bridgeRef.current) bridgeRef.current = getRememberBridge()
  const bridge = bridgeRef.current
  const [taskActionsEnabled, setTaskActionsEnabled] = useState<boolean | null>(null)

  useEffect(() => {
    if (!bridge) return
    let alive = true
    let generation = 0
    const refresh = async () => {
      const current = ++generation
      try {
        const enabled = await bridge.getAssistantTaskActionsEnabled()
        if (alive && current === generation) setTaskActionsEnabled(enabled)
      } catch {
        // An unavailable capability must not accidentally expose a second execution owner.
      }
    }
    const unsubscribe = bridge.onAssistantChanged(() => void refresh())
    void refresh()
    return () => {
      alive = false
      unsubscribe()
    }
  }, [bridge])
  const [userName, setUserName] = useState<string | null>(null)
  const [state, setState] = useState<CaptureState | null>(null)
  const [days, setDays] = useState<Day[]>([])
  const daySnapshotRef = useRef<DaySnapshot | null>(null)
  const latestDayRevisionRef = useRef(0)
  const [workItems, setWorkItems] = useState<WorkItem[]>([])
  const workItemRevisionRef = useRef(0)
  const workItemUpdatesRef = useRef(new Map<string, number>())
  const workItemReadRef = useRef(0)
  const [settings, setSettings] = useState<LocalSettings | null>(null)
  const [agentConnections, setAgentConnections] = useState<Partial<Record<AgentProvider, AgentSetup>>>({})
  const agent = agentConnections[settings?.defaultAgentProvider ?? 'codex'] ?? null
  const [wikiBySpace, setWikiBySpace] = useState<Record<string, WikiPage[]>>({})
  const [wikiOverview, setWikiOverview] = useState<WikiOverview | null>(null)
  const wikiCacheAccessRef = useRef(createWikiCacheAccess())
  const wikiEditorFlushRef = useRef(new Map<string, () => Promise<void>>())
  const [bootstrapLoadStatus, setBootstrapLoadStatus] = useState<LocalDataLoadState>('loading')
  const [dataLoadStatus, setDataLoadStatus] = useState(initialDataLoadStatus)
  const [activeWikiSpaceId, setActiveWikiSpaceId] = useState(PERSONAL_WIKI_SPACE_ID)
  const wiki = wikiBySpace[activeWikiSpaceId] ?? emptyWikiPages
  const activeWikiSpaceIdRef = useRef(PERSONAL_WIKI_SPACE_ID)
  const requestedWikiSpaceIdRef = useRef(PERSONAL_WIKI_SPACE_ID)

  const acceptWikiOverview = useCallback((next: WikiOverview, revision = wikiCacheAccessRef.current.revision()) => {
    const overview = wikiCacheAccessRef.current.acceptOverview(next, revision)
    if (!overview) return false
    setWikiOverview(overview)
    setWikiBySpace((current) => retainWikiPageCache(current, overview))
    if (!overview.spaces.some((space) => space.id === activeWikiSpaceIdRef.current)) {
      activeWikiSpaceIdRef.current = PERSONAL_WIKI_SPACE_ID
      requestedWikiSpaceIdRef.current = PERSONAL_WIKI_SPACE_ID
      setActiveWikiSpaceId(PERSONAL_WIKI_SPACE_ID)
    }
    return true
  }, [])

  const acceptWikiPages = useCallback((spaceId: string, pages: WikiPage[], revision: number) => {
    if (!wikiCacheAccessRef.current.acceptsPages(spaceId, revision)) return false
    setWikiBySpace((current) => {
      if (!wikiCacheAccessRef.current.acceptsPages(spaceId, revision)) return current
      return { ...current, [spaceId]: pages }
    })
    return true
  }, [])
  const registerWikiEditorFlush = useCallback((spaceId: string, flush: () => Promise<void>) => {
    wikiEditorFlushRef.current.set(spaceId, flush)
    return () => {
      if (wikiEditorFlushRef.current.get(spaceId) === flush) wikiEditorFlushRef.current.delete(spaceId)
    }
  }, [])
  const canAccessWikiSpace = useCallback((spaceId: string) => {
    return wikiCacheAccessRef.current.acceptsPages(spaceId, wikiCacheAccessRef.current.revision())
  }, [])

  const [update, setUpdate] = useState<UpdateState>({
    status: 'unavailable',
    availability: 'development',
    currentVersion: '',
    version: null,
    downloadProgress: null,
    errorStage: null,
    revision: -1,
  })
  const [updateRestartPending, setUpdateRestartPending] = useState(false)
  const updateRestartPendingRef = useRef(false)

  const requireBridge = useCallback(() => {
    if (!bridge) throw new Error('Remember bridge is not available')
    return bridge
  }, [bridge])

  const acceptAgent = useCallback((nextAgent: AgentSetup) => {
    setAgentConnections((current) => ({ ...current, [nextAgent.provider]: nextAgent }))
  }, [])
  const refreshAgent = useCallback(
    async (provider?: AgentProvider) => {
      acceptAgent(await requireBridge().checkAgent(provider))
    },
    [acceptAgent, requireBridge]
  )

  const beginDataLoad = useCallback((resource: LocalDataResource) => {
    setDataLoadStatus((current) => (current[resource] === 'ready' ? current : { ...current, [resource]: 'loading' }))
  }, [])

  const completeDataLoad = useCallback((resource: LocalDataResource) => {
    setDataLoadStatus((current) => (current[resource] === 'ready' ? current : { ...current, [resource]: 'ready' }))
  }, [])

  const failDataLoad = useCallback((resource: LocalDataResource) => {
    setDataLoadStatus((current) => (current[resource] === 'ready' ? current : { ...current, [resource]: 'error' }))
  }, [])

  const acceptState = useCallback((nextState: CaptureState) => setState(nextState), [])
  const acceptDaySnapshot = useCallback(
    (snapshot: DaySnapshot) => {
      if (daySnapshotRef.current && snapshot.revision <= daySnapshotRef.current.revision) return
      daySnapshotRef.current = snapshot
      setDays(snapshot.days)
      completeDataLoad('days')
    },
    [completeDataLoad]
  )

  const refreshDays = useMemo(
    () =>
      coalesceRefresh(async () => {
        if (!bridge) return
        beginDataLoad('days')
        try {
          const revision = daySnapshotRef.current ? await bridge.getDayRevision() : null
          if (revision !== null && daySnapshotRef.current && revision <= daySnapshotRef.current.revision) return
          do {
            acceptDaySnapshot(await bridge.listDaySnapshot())
          } while ((daySnapshotRef.current?.revision ?? -1) < latestDayRevisionRef.current)
        } catch {
          failDataLoad('days')
        }
      }),
    [acceptDaySnapshot, beginDataLoad, bridge, failDataLoad]
  )

  const acceptDayChanges = useCallback(
    (changes: DayChanges) => {
      latestDayRevisionRef.current = Math.max(latestDayRevisionRef.current, changes.revision)
      const current = daySnapshotRef.current
      // The initial read catches up if an update overtakes its IPC response.
      if (!current) return
      const next = applyDayChanges(current, changes)
      if (next) acceptDaySnapshot(next)
      else void refreshDays()
    },
    [acceptDaySnapshot, refreshDays]
  )

  const processingConversations = days.flatMap((day) =>
    (day.memory?.conversations ?? []).filter((conversation) => conversation.processing && !conversation.processingError)
  )
  const hasProcessingConversations = processingConversations.length > 0
  useEffect(() => {
    if (!bridge || !hasProcessingConversations) return
    // Native Revinote scheduling owns cloud polling; this recovers missed local change events.
    return pollConversationProcessing(refreshDays)
  }, [bridge, hasProcessingConversations, refreshDays])

  const acceptUpdate = useCallback((nextUpdate: UpdateState) => {
    setUpdate((currentUpdate) => (nextUpdate.revision >= currentUpdate.revision ? nextUpdate : currentUpdate))
  }, [])

  const upsertWorkItem = useCallback((item: WorkItem) => {
    workItemUpdatesRef.current.set(item.id, ++workItemRevisionRef.current)
    setWorkItems((current) => {
      const index = current.findIndex((entry) => entry.id === item.id)
      if (index >= 0) {
        if (current[index].updatedAt > item.updatedAt) return current
        const next = current.slice()
        next[index] = item
        return next
      }
      return [item, ...current]
    })
  }, [])

  const refreshWorkItems = useCallback(async () => {
    if (!bridge) return
    const read = ++workItemReadRef.current
    const revision = workItemRevisionRef.current
    beginDataLoad('workItems')
    try {
      const items = await bridge.listWorkItems()
      if (read !== workItemReadRef.current) return
      const updatedSinceRead = new Set(
        [...workItemUpdatesRef.current].flatMap(([id, updated]) => (updated > revision ? [id] : []))
      )
      setWorkItems((current) => reconcileWorkItems(current, items, updatedSinceRead))
      completeDataLoad('workItems')
    } catch {
      if (read === workItemReadRef.current) failDataLoad('workItems')
    }
  }, [beginDataLoad, bridge, completeDataLoad, failDataLoad])

  const hasRunningWorkItems = workItems.some((item) => item.attention === 'agent_running')
  useEffect(() => {
    if (!hasRunningWorkItems) return
    const interval = window.setInterval(() => void refreshWorkItems(), 2000)
    return () => window.clearInterval(interval)
  }, [hasRunningWorkItems, refreshWorkItems])

  const refresh = useCallback(async () => {
    if (!bridge) {
      setBootstrapLoadStatus('error')
      return
    }
    setBootstrapLoadStatus((current) => (current === 'ready' ? current : 'loading'))
    const activeSpaceId = activeWikiSpaceIdRef.current
    const wikiRevision = wikiCacheAccessRef.current.revision()
    beginDataLoad('days')
    beginDataLoad('workItems')
    beginDataLoad('wiki')
    const statePromise = bridge.getState()
    const settingsPromise = bridge.getSettings()
    const bootstrapOperation = Promise.allSettled([statePromise, settingsPromise]).then(
      ([stateResult, settingsResult]) => {
        if (stateResult.status === 'fulfilled') acceptState(stateResult.value)
        if (settingsResult.status === 'fulfilled') setSettings(settingsResult.value)
        if (stateResult.status === 'fulfilled' && settingsResult.status === 'fulfilled') {
          setBootstrapLoadStatus('ready')
        } else {
          setBootstrapLoadStatus((current) => (current === 'ready' ? current : 'error'))
        }
      }
    )
    const wikiOperation = Promise.allSettled([bridge.getWikiOverview(), bridge.listWikiPages(activeSpaceId)]).then(
      ([overviewResult, pagesResult]) => {
        if (overviewResult.status === 'fulfilled') acceptWikiOverview(overviewResult.value, wikiRevision)
        if (pagesResult.status === 'fulfilled') {
          acceptWikiPages(activeSpaceId, pagesResult.value, wikiRevision)
        }
        if (overviewResult.status === 'fulfilled' && pagesResult.status === 'fulfilled') completeDataLoad('wiki')
        else failDataLoad('wiki')
      }
    )
    const operations = [
      bridge.getUserName().then(setUserName),
      refreshDays(),
      refreshWorkItems(),
      bootstrapOperation,
      bridge
        .checkAgent()
        .then(acceptAgent)
        .catch(async () => {
          const nextSettings = await settingsPromise.catch(() => null)
          acceptAgent({
            provider: nextSettings?.defaultAgentProvider ?? 'codex',
            status: 'error',
            executable: null,
            detail: 'De agentstatus kon niet worden gecontroleerd.',
          })
        }),
      wikiOperation,
      bridge.getUpdateState().then(acceptUpdate),
    ]
    await Promise.allSettled(operations)
  }, [
    acceptAgent,
    acceptWikiOverview,
    acceptWikiPages,
    acceptState,
    acceptUpdate,
    beginDataLoad,
    bridge,
    completeDataLoad,
    failDataLoad,
    refreshWorkItems,
    refreshDays,
  ])

  const refreshMemory = useMemo(
    () =>
      coalesceRefresh(async () => {
        if (!bridge) return
        const spaceId = activeWikiSpaceIdRef.current
        const wikiRevision = wikiCacheAccessRef.current.revision()
        beginDataLoad('wiki')
        const workItemsOperation = refreshWorkItems()
        const [overviewResult, pageResult] = await Promise.allSettled([
          bridge.getWikiOverview(),
          bridge.listWikiPages(spaceId),
        ])
        if (overviewResult.status === 'fulfilled') acceptWikiOverview(overviewResult.value, wikiRevision)
        if (pageResult.status === 'fulfilled') {
          acceptWikiPages(spaceId, pageResult.value, wikiRevision)
        }
        if (overviewResult.status === 'fulfilled' && pageResult.status === 'fulfilled') completeDataLoad('wiki')
        else failDataLoad('wiki')
        await workItemsOperation
      }),
    [acceptWikiOverview, acceptWikiPages, beginDataLoad, bridge, completeDataLoad, failDataLoad, refreshWorkItems]
  )

  const loadAllWikiPages = useCallback(async () => {
    const currentBridge = requireBridge()
    const wikiRevision = wikiCacheAccessRef.current.revision()
    const overview = await currentBridge.getWikiOverview()
    if (!acceptWikiOverview(overview, wikiRevision)) return
    const pagesRevision = wikiCacheAccessRef.current.revision()
    const pageResults = await Promise.allSettled(
      overview.spaces.map(async (space) => [space.id, await currentBridge.listWikiPages(space.id)] as const)
    )
    const loadedPages = Object.fromEntries(
      pageResults.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []))
    )
    for (const [spaceId, pages] of Object.entries(loadedPages)) acceptWikiPages(spaceId, pages, pagesRevision)
    if (pageResults.some((result) => result.status === 'rejected')) throw new Error('wiki-pages-unavailable')
    completeDataLoad('wiki')
  }, [acceptWikiOverview, acceptWikiPages, completeDataLoad, requireBridge])

  const updateLocalSettings = useCallback(
    async (patch: Partial<LocalSettings>) => {
      const nextSettings = await requireBridge().updateSettings(patch)
      setSettings(nextSettings)
      return nextSettings
    },
    [requireBridge]
  )

  const checkForUpdate = useCallback(async () => {
    const nextUpdate = await requireBridge().checkForUpdate()
    acceptUpdate(nextUpdate)
    return nextUpdate
  }, [acceptUpdate, requireBridge])

  const downloadUpdate = useCallback(async () => {
    const nextUpdate = await requireBridge().downloadUpdate()
    acceptUpdate(nextUpdate)
    return nextUpdate
  }, [acceptUpdate, requireBridge])

  const restartToUpdate = useCallback(async () => {
    if (updateRestartPendingRef.current) return

    updateRestartPendingRef.current = true
    setUpdateRestartPending(true)
    try {
      await requireBridge().restartToUpdate()
    } catch (error) {
      updateRestartPendingRef.current = false
      setUpdateRestartPending(false)
      throw error
    }
  }, [requireBridge])

  const selectWikiSpace = useCallback(
    async (spaceId: string) => {
      const currentBridge = requireBridge()
      const wikiRevision = wikiCacheAccessRef.current.revision()
      requestedWikiSpaceIdRef.current = spaceId
      const cachedPages = wikiBySpace[spaceId]
      if (cachedPages && wikiCacheAccessRef.current.acceptsPages(spaceId, wikiRevision)) {
        activeWikiSpaceIdRef.current = spaceId
        setActiveWikiSpaceId(spaceId)
      }

      const [pages, overview] = await Promise.all([
        currentBridge.listWikiPages(spaceId),
        currentBridge.getWikiOverview(),
      ])
      acceptWikiOverview(overview, wikiRevision)
      acceptWikiPages(spaceId, pages, wikiRevision)
      completeDataLoad('wiki')
      if (
        requestedWikiSpaceIdRef.current !== spaceId ||
        !wikiCacheAccessRef.current.acceptsPages(spaceId, wikiRevision)
      )
        return

      activeWikiSpaceIdRef.current = spaceId
      setActiveWikiSpaceId(spaceId)
    },
    [acceptWikiOverview, acceptWikiPages, completeDataLoad, requireBridge, wikiBySpace]
  )

  const createLocalWikiSpace = useCallback(
    async (input: CreateLocalWikiSpaceInput) => {
      const wikiRevision = wikiCacheAccessRef.current.revision()
      const overview = await requireBridge().createLocalWikiSpace(input)
      acceptWikiOverview(overview, wikiRevision)
      return overview
    },
    [acceptWikiOverview, requireBridge]
  )

  const removeLocalWikiSpace = useCallback(
    async (input: RemoveLocalWikiSpaceInput) => {
      const currentBridge = requireBridge()
      const wikiRevision = wikiCacheAccessRef.current.revision()
      const overview = await currentBridge.removeLocalWikiSpace(input)
      removeWikiDrafts([input.spaceId])
      acceptWikiOverview(overview, wikiRevision)
      setWikiBySpace((current) =>
        Object.fromEntries(Object.entries(current).filter(([spaceId]) => spaceId !== input.spaceId))
      )
      if (activeWikiSpaceIdRef.current === input.spaceId) {
        activeWikiSpaceIdRef.current = PERSONAL_WIKI_SPACE_ID
        setActiveWikiSpaceId(PERSONAL_WIKI_SPACE_ID)
        const pages = await currentBridge.listWikiPages(PERSONAL_WIKI_SPACE_ID)
        acceptWikiPages(PERSONAL_WIKI_SPACE_ID, pages, wikiRevision)
      }
      return overview
    },
    [acceptWikiOverview, acceptWikiPages, requireBridge]
  )

  const updateWikiSpace = useCallback(
    async (input: UpdateWikiSpaceInput) => {
      const wikiRevision = wikiCacheAccessRef.current.revision()
      const overview = await requireBridge().updateWikiSpace(input)
      acceptWikiOverview(overview, wikiRevision)
      return overview
    },
    [acceptWikiOverview, requireBridge]
  )

  const reorderWikiSpaces = useCallback(
    async (input: ReorderWikiSpacesInput) => {
      const wikiRevision = wikiCacheAccessRef.current.revision()
      const previousOverview = wikiOverview
      if (previousOverview) {
        const spacesById = new Map(previousOverview.spaces.map((space) => [space.id, space]))
        setWikiOverview({
          ...previousOverview,
          spaces: input.spaceIds.flatMap((spaceId) => {
            const space = spacesById.get(spaceId)
            return space ? [space] : []
          }),
        })
      }
      try {
        const overview = await requireBridge().reorderWikiSpaces(input)
        acceptWikiOverview(overview, wikiRevision)
        return overview
      } catch (error) {
        if (previousOverview) acceptWikiOverview(previousOverview, wikiRevision)
        throw error
      }
    },
    [acceptWikiOverview, requireBridge, wikiOverview]
  )

  const createWikiPage = useCallback(
    async (input: CreateWikiPageInput) => {
      const wikiRevision = wikiCacheAccessRef.current.revision()
      const pages = await requireBridge().createWikiPage(input)
      acceptWikiPages(input.spaceId, pages, wikiRevision)
      return pages
    },
    [acceptWikiPages, requireBridge]
  )

  const saveWikiPage = useCallback(
    async (input: SaveWikiPageInput) => {
      const wikiRevision = wikiCacheAccessRef.current.revision()
      const pages = await requireBridge().saveWikiPage(input)
      acceptWikiPages(input.spaceId, pages, wikiRevision)
      return pages
    },
    [acceptWikiPages, requireBridge]
  )

  const getWikiPageHistory = useCallback(
    (input: WikiPageHistoryInput) => requireBridge().getWikiPageHistory(input),
    [requireBridge]
  )

  const restoreWikiPageRevision = useCallback(
    async (input: RestoreWikiPageRevisionInput) => {
      const wikiRevision = wikiCacheAccessRef.current.revision()
      const pages = await requireBridge().restoreWikiPageRevision(input)
      acceptWikiPages(input.spaceId, pages, wikiRevision)
      return pages
    },
    [acceptWikiPages, requireBridge]
  )

  const deleteWikiPage = useCallback(
    async (input: DeleteWikiPageInput) => {
      const wikiRevision = wikiCacheAccessRef.current.revision()
      const pages = await requireBridge().deleteWikiPage(input)
      acceptWikiPages(input.spaceId, pages, wikiRevision)
      return pages
    },
    [acceptWikiPages, requireBridge]
  )

  const moveWikiProject = useCallback(
    async (input: MoveWikiProjectInput) => {
      const currentBridge = requireBridge()
      const wikiRevision = wikiCacheAccessRef.current.revision()
      const overview = await currentBridge.moveWikiProject(input)
      const [sourcePages, destinationPages] = await Promise.all([
        currentBridge.listWikiPages(input.sourceSpaceId),
        currentBridge.listWikiPages(input.destinationSpaceId),
      ])
      acceptWikiOverview(overview, wikiRevision)
      acceptWikiPages(input.sourceSpaceId, sourcePages, wikiRevision)
      acceptWikiPages(input.destinationSpaceId, destinationPages, wikiRevision)
      return overview
    },
    [acceptWikiOverview, acceptWikiPages, requireBridge]
  )

  const applyKnowledgeSuggestion = useCallback(
    async (input: KnowledgeSuggestionActionInput) => {
      const currentBridge = requireBridge()
      const wikiRevision = wikiCacheAccessRef.current.revision()
      const overview = await currentBridge.applyKnowledgeSuggestion(input)
      const suggestion = overview.suggestions.find((item) => item.id === input.suggestionId)
      const spaceId = input.destinationSpaceId ?? suggestion?.destinationSpaceId ?? suggestion?.suggestedSpaceId
      if (spaceId) {
        const pages = await currentBridge.listWikiPages(spaceId)
        acceptWikiPages(spaceId, pages, wikiRevision)
      }
      acceptWikiOverview(overview, wikiRevision)
      return overview
    },
    [acceptWikiOverview, acceptWikiPages, requireBridge]
  )

  const dismissKnowledgeSuggestion = useCallback(
    async (input: KnowledgeSuggestionActionInput) => {
      const wikiRevision = wikiCacheAccessRef.current.revision()
      const overview = await requireBridge().dismissKnowledgeSuggestion(input)
      acceptWikiOverview(overview, wikiRevision)
      return overview
    },
    [acceptWikiOverview, requireBridge]
  )

  useEffect(() => {
    if (!bridge) {
      setBootstrapLoadStatus('error')
      return
    }
    const uninstallErrorReporting = installRendererErrorReporting(bridge)
    const unsubscribeState = bridge.onState(acceptState)
    const unsubscribeSettings = bridge.onSettingsChanged(setSettings)
    const unsubscribeDays = bridge.onDays(acceptDayChanges)
    const unsubscribeMemory = bridge.onMemoryChanged(() => void refreshMemory())
    const unsubscribeUpdate = bridge.onUpdateState(acceptUpdate)
    void refresh()
    return () => {
      uninstallErrorReporting()
      unsubscribeState()
      unsubscribeSettings()
      unsubscribeDays()
      unsubscribeMemory()
      unsubscribeUpdate()
    }
  }, [acceptDayChanges, acceptState, acceptUpdate, bridge, refresh, refreshMemory])

  const analysisProvider = settings?.dayAnalysisProvider ?? settings?.defaultAgentProvider
  const authenticationFailure = days
    .filter(
      (day) =>
        day.refresh.status === 'failed' &&
        (day.refresh.error === 'agent-auth-required' || day.refresh.error === 'claude-auth-required')
    )
    .map((day) => `${day.id}:${day.refresh.run?.id ?? ''}`)
    .sort()
    .join(',')

  useEffect(() => {
    if (!analysisProvider || settings?.offlineMode) return
    if (authenticationFailure || analysisProvider !== settings?.defaultAgentProvider) {
      void refreshAgent(analysisProvider).catch(() => undefined)
    }
  }, [analysisProvider, authenticationFailure, refreshAgent, settings?.defaultAgentProvider, settings?.offlineMode])

  const claudeSignedOut =
    (settings?.defaultAgentProvider === 'claude' || analysisProvider === 'claude') &&
    agentConnections.claude?.status === 'signed-out'
  const codexSignedOut =
    (settings?.defaultAgentProvider === 'codex' || analysisProvider === 'codex') &&
    agentConnections.codex?.status === 'signed-out'
  useEffect(() => {
    if (settings?.offlineMode || (!claudeSignedOut && !codexSignedOut)) return

    let isChecking = false
    const checkAuthentication = async () => {
      if (isChecking) return
      isChecking = true
      try {
        await Promise.all([
          ...(claudeSignedOut ? [refreshAgent('claude')] : []),
          ...(codexSignedOut ? [refreshAgent('codex')] : []),
        ])
      } finally {
        isChecking = false
      }
    }
    const interval = window.setInterval(() => void checkAuthentication().catch(() => undefined), 1_500)
    return () => window.clearInterval(interval)
  }, [claudeSignedOut, codexSignedOut, refreshAgent, settings?.offlineMode])

  return (
    <LocalBridgeContext.Provider
      value={{
        bridge,
        taskActionsEnabled,
        bootstrapLoadStatus,
        ready: Boolean(bridge && state && settings && bootstrapLoadStatus === 'ready'),
        userName,
        state,
        acceptState,
        days,
        acceptDaySnapshot,
        workItems,
        settings,
        agent,
        agentConnections,
        refreshAgent,
        wiki,
        wikiBySpace,
        wikiOverview,
        dataLoadStatus,
        activeWikiSpaceId,
        update,
        updateRestartPending,
        refresh,
        loadAllWikiPages,
        upsertWorkItem,
        updateSettings: updateLocalSettings,
        checkForUpdate,
        downloadUpdate,
        restartToUpdate,
        selectWikiSpace,
        registerWikiEditorFlush,
        canAccessWikiSpace,
        createLocalWikiSpace,
        removeLocalWikiSpace,
        updateWikiSpace,
        reorderWikiSpaces,
        createWikiPage,
        saveWikiPage,
        deleteWikiPage,
        getWikiPageHistory,
        restoreWikiPageRevision,
        moveWikiProject,
        applyKnowledgeSuggestion,
        dismissKnowledgeSuggestion,
      }}
    >
      {children}
    </LocalBridgeContext.Provider>
  )
}

export function useLocalBridge() {
  const context = useContext(LocalBridgeContext)
  if (!context) throw new Error('useLocalBridge must be used within LocalBridgeProvider')
  return context
}
