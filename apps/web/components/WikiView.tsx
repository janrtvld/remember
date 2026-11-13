'use client'

import {
  Dialog,
  DialogBackdrop,
  DialogDescription,
  DialogPanel,
  DialogTitle,
  Menu,
  MenuButton,
  MenuItem,
  Popover,
  PopoverButton,
  PopoverPanel,
  Transition,
} from '@headlessui/react'
import { DashboardPageHeader } from '@internal/components/DashboardPageHeader'
import { useLocalBridge } from '@internal/context/LocalBridgeProvider'
import { useI18n } from '@internal/locales'
import { Button } from '@internal/ui/Button'
import { DropdownMenuItems, DropdownSelect, dropdownDangerItemStyle, dropdownItemStyle } from '@internal/ui/Dropdown'
import { IconButton } from '@internal/ui/IconButton'
import { PendingIndicator } from '@internal/ui/PendingIndicator'
import { Spinner } from '@internal/ui/Spinner'
import {
  type KnowledgeSuggestion,
  type MoveWikiProjectInput,
  PERSONAL_WIKI_SPACE_ID,
  type UpdateWikiSpaceInput,
  type WikiOverview,
  type WikiPage,
  type WikiPageHistory,
  type WikiPageRevision,
  type WikiSpace,
} from '@remember/shared'
import {
  ArrowLeft as IconArrowLeft,
  ArrowRight as IconArrowRight,
  X as IconCrossSmall,
  Ellipsis as IconDotGrid1x3HorizontalTight,
  FileText as IconFileText,
  History as IconHistory,
  Mic as IconMicrophone,
  Plus as IconPlusSmall,
  Trash2 as IconTrashCanSimple,
} from 'lucide-react'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { BreadcrumbSeparator } from './BreadcrumbSeparator'
import { DashboardLoadError } from './DashboardLoadError'
import { MarkdownContent } from './MarkdownContent'
import { spaceConversationSource } from './spaceConversation'
import { WikiEvidence } from './WikiEvidence'
import {
  WikiSpaceBadge,
  WikiSpaceGlyph,
  wikiSpaceColorChoices,
  wikiSpaceColorSwatch,
  wikiSpaceIconChoices,
} from './WikiSpaceBadge'
import { categoryForSlug, type WikiCategory, wikiCategories } from './wikiCategories'
import { wikiAncestors, wikiCategoryCount, wikiDirectChildren, wikiRootPages } from './wikiHierarchy'
import { wikiRevisionActor } from './wikiHistory'
import { editableWikiPages, findCreatedWikiPage, isEditableWikiPage } from './wikiPages'
import { wikiCategoryHref, wikiHomeHref, wikiPageHref, wikiSuggestionsHref } from './wikiRoutes'

const WikiEditor = dynamic(() => import('./WikiEditor').then((module) => module.WikiEditor), {
  loading: () => (
    <div className="mx-auto flex min-h-[28rem] max-w-[800px] items-center justify-center">
      <PendingIndicator />
    </div>
  ),
})

export type WikiRoute =
  | { kind: 'home' | 'suggestions' | 'new-space'; spaceId: string }
  | { kind: 'category'; spaceId: string; category: string }
  | { kind: 'page'; spaceId: string; slug: string }

function sortByRecent(pages: WikiPage[]) {
  return [...pages].sort((first, second) => second.updatedAt - first.updatedAt)
}

export function WikiView({ route }: { route: WikiRoute }) {
  const { t } = useI18n()
  const local = useLocalBridge()
  const {
    ready,
    wiki,
    wikiBySpace,
    wikiOverview,
    activeWikiSpaceId,
    selectWikiSpace,
    createWikiPage,
    saveWikiPage,
    deleteWikiPage,
    getWikiPageHistory,
    restoreWikiPageRevision,
    removeLocalWikiSpace,
    updateWikiSpace,
  } = local
  const router = useRouter()
  const routeSpace = wikiOverview?.spaces.find((space) => space.id === route.spaceId) ?? null
  const selectedSlug = route.kind === 'page' ? route.slug : null
  const selectedCategorySlug = route.kind === 'category' ? route.category : null
  const routeWiki = wikiBySpace[route.spaceId] ?? (activeWikiSpaceId === route.spaceId ? wiki : null)
  const pages = useMemo(() => editableWikiPages(routeWiki ?? []), [routeWiki])
  const [newPage, setNewPage] = useState<WikiPage | null>(null)
  const selected = selectedSlug
    ? (pages.find((page) => page.slug === selectedSlug) ??
      (newPage?.slug === selectedSlug && isEditableWikiPage(newPage) ? newPage : null))
    : null
  const selectedCategory = selectedCategorySlug
    ? (wikiCategories(pages).find((category) => category.slug === selectedCategorySlug) ?? null)
    : null
  const [creatingCategory, setCreatingCategory] = useState<string | null>(null)
  const [creationError, setCreationError] = useState<string | null>(null)
  const [pageToDelete, setPageToDelete] = useState<WikiPage | null>(null)
  const [pageDeleteError, setPageDeleteError] = useState<string | null>(null)
  const [historyPage, setHistoryPage] = useState<WikiPage | null>(null)
  const [editorGeneration, setEditorGeneration] = useState(0)
  const [deletingSlug, setDeletingSlug] = useState<string | null>(null)
  const [spaceDialogOpen, setSpaceDialogOpen] = useState(route.kind === 'new-space')
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [spaceToRemove, setSpaceToRemove] = useState<WikiSpace | null>(null)
  const [removingSpace, setRemovingSpace] = useState(false)
  const [removeSpaceError, setRemoveSpaceError] = useState<string | null>(null)
  const [wikiError, setWikiError] = useState<string | null>(null)
  const [projectDialog, setProjectDialog] = useState<{
    sourceSpaceId: string
    projectSlug?: string
    destinationSpaceId?: string
  } | null>(null)
  const openedNewPageRef = useRef<string | null>(null)
  const spaceDialogDestinationRef = useRef<string | null>(null)
  const projectMoveTargetRef = useRef<{ spaceId: string; slug: string } | null>(null)
  const editorFlushRef = useRef<(() => Promise<void>) | null>(null)
  const activeSpace = routeWiki ? routeSpace : null
  useEffect(() => {
    if (!wikiOverview || routeSpace) return
    setNewPage(null)
    setHistoryPage(null)
    setPageToDelete(null)
    setSpaceToRemove(null)
    setProjectDialog(null)
    setSettingsOpen(false)
  }, [routeSpace, wikiOverview])
  const hasProjectMoveDestination = wikiOverview?.spaces.some((space) => space.id !== activeSpace?.id) === true
  const registerEditorFlush = useCallback((flush: (() => Promise<void>) | null) => {
    editorFlushRef.current = flush
  }, [])

  useEffect(() => {
    if (!ready || !wikiOverview) return
    if (!routeSpace) {
      router.replace(wikiHomeHref(PERSONAL_WIKI_SPACE_ID))
      return
    }
    if (activeWikiSpaceId === routeSpace.id) return
    setWikiError(null)
    void selectWikiSpace(routeSpace.id).catch(() => setWikiError(t('Deze wiki kon niet worden geopend.')))
  }, [activeWikiSpaceId, ready, routeSpace, router, selectWikiSpace, t, wikiOverview])

  useEffect(() => {
    if (!newPage) return
    if (selectedSlug === newPage.slug) {
      openedNewPageRef.current = newPage.slug
      return
    }
    if (openedNewPageRef.current === newPage.slug) {
      openedNewPageRef.current = null
      setNewPage(null)
    }
  }, [newPage, selectedSlug])

  useEffect(() => {
    if (route.kind !== 'home') setSettingsOpen(false)
  }, [route.kind])

  useEffect(() => {
    if (!ready || !activeSpace) return
    if (projectMoveTargetRef.current) return
    const hasInvalidPage = route.kind === 'page' && !selected
    const hasInvalidCategory = route.kind === 'category' && !selectedCategory
    if (hasInvalidPage || hasInvalidCategory) router.replace(wikiHomeHref(activeSpace.id))
  }, [activeSpace, ready, route.kind, router, selected, selectedCategory])

  useEffect(() => {
    const target = projectMoveTargetRef.current
    if (
      target &&
      selected?.slug === target.slug &&
      route.kind === 'page' &&
      route.spaceId === target.spaceId &&
      route.slug === target.slug
    ) {
      projectMoveTargetRef.current = null
    }
  }, [route, selected])

  async function createPageInCategory(category: string, parentSlug?: string) {
    const creationTarget = parentSlug ?? category
    setCreatingCategory(creationTarget)
    setCreationError(null)

    try {
      if (parentSlug) await editorFlushRef.current?.()
      const nextPages = await createWikiPage({
        spaceId: activeWikiSpaceId,
        title: t('Naamloze pagina'),
        category,
        ...(parentSlug ? { parentSlug } : {}),
      })
      const createdPage = findCreatedWikiPage(pages, nextPages, { category, parentSlug })
      if (!createdPage) throw new Error('wiki-page-not-created')
      setNewPage(createdPage)
      router.push(wikiPageHref(activeWikiSpaceId, createdPage.slug))
    } catch {
      setCreationError(t('De pagina kon niet worden aangemaakt.'))
    } finally {
      setCreatingCategory((current) => (current === creationTarget ? null : current))
    }
  }

  async function deletePage(page: WikiPage) {
    setDeletingSlug(page.slug)
    setPageDeleteError(null)
    try {
      await deleteWikiPage({ spaceId: activeWikiSpaceId, slug: page.slug })
      if (newPage?.slug === page.slug) setNewPage(null)
      setPageToDelete(null)
      router.replace(wikiHomeHref(activeWikiSpaceId))
    } catch {
      setPageDeleteError(t('De pagina kon niet worden verwijderd.'))
    } finally {
      setDeletingSlug(null)
    }
  }

  function closeSpaceDialog() {
    spaceDialogDestinationRef.current = route.kind === 'new-space' ? route.spaceId : null
    setSpaceDialogOpen(false)
  }

  function completeSpaceDialog(spaceId: string) {
    setWikiError(null)
    setNewPage(null)
    spaceDialogDestinationRef.current = spaceId
    setSpaceDialogOpen(false)
  }

  async function removeSpace() {
    if (!spaceToRemove || removingSpace) return
    setRemovingSpace(true)
    setRemoveSpaceError(null)
    try {
      try {
        await editorFlushRef.current?.()
      } catch {
        setRemoveSpaceError(t('De laatste wijzigingen konden niet worden opgeslagen.'))
        return
      }
      await removeLocalWikiSpace({ spaceId: spaceToRemove.id })
      setNewPage(null)
      setSpaceToRemove(null)
      router.replace(wikiHomeHref(PERSONAL_WIKI_SPACE_ID))
    } catch {
      setRemoveSpaceError(t('De space kon niet worden verwijderd.'))
    } finally {
      setRemovingSpace(false)
    }
  }

  if (!ready || local.dataLoadStatus.wiki === 'loading') return <WikiLoadingState />
  if (local.dataLoadStatus.wiki === 'error') {
    return (
      <DashboardLoadError
        title={routeSpace?.name ?? t('Spaces')}
        message={t('Deze Space kon niet worden geladen.')}
        onRetry={local.refresh}
      />
    )
  }
  if (!wikiOverview) return <WikiLoadingState />
  if (!activeSpace && wikiError) {
    return (
      <DashboardLoadError
        title={routeSpace?.name ?? t('Spaces')}
        message={wikiError}
        onRetry={async () => {
          setWikiError(null)
          await selectWikiSpace(route.spaceId).catch(() => {
            setWikiError(t('Deze wiki kon niet worden geopend.'))
          })
        }}
      />
    )
  }
  if (!activeSpace) return <WikiLoadingState />

  const suggestions = wikiOverview.suggestions.filter(
    (suggestion) => suggestion.status === 'pending' && suggestion.suggestedSpaceId === activeSpace.id
  )

  const breadcrumb = (options?: {
    suggestions?: boolean
    category?: WikiCategory
    page?: WikiPage
    onCreatePage?: () => void
    onCreateSubpage?: () => void
    onDelete?: () => void
    onHistory?: () => void
    onMoveProject?: () => void
    onOpenSettings?: () => void
  }) => (
    <>
      <WikiBreadcrumb
        {...options}
        space={activeSpace}
        pages={pages}
        syncing={activeSpace.id === PERSONAL_WIKI_SPACE_ID && wikiOverview.contextImportRunning}
        settingsOpen={settingsOpen}
        onRemoveSpace={() => {
          setRemoveSpaceError(null)
          setSpaceToRemove(activeSpace)
        }}
        creatingPage={Boolean(options?.category && creatingCategory === options.category.slug)}
        creatingSubpage={Boolean(options?.page && creatingCategory === options.page.slug)}
        deleting={deletingSlug !== null}
      />
      {wikiError ? (
        <div className="mx-auto w-full max-w-[800px] px-6 pt-4 sm:px-10">
          <p className="text-danger-700 text-sm" role="alert">
            {wikiError}
          </p>
        </div>
      ) : null}
    </>
  )

  const dialogs = (
    <>
      <WikiSettingsDialog
        open={settingsOpen}
        space={activeSpace}
        onClose={() => setSettingsOpen(false)}
        onUpdateSpace={updateWikiSpace}
      />
      <WikiSpaceDialog
        open={spaceDialogOpen}
        onClose={closeSpaceDialog}
        afterLeave={() => {
          const destination = spaceDialogDestinationRef.current
          spaceDialogDestinationRef.current = null
          if (destination) router.replace(wikiHomeHref(destination))
        }}
        onCreate={async (name, description) => {
          const existingIds = new Set(wikiOverview.spaces.map((space) => space.id))
          const overview = await local.createLocalWikiSpace({ name, description })
          const created = overview.spaces.find((space) => !existingIds.has(space.id))
          completeSpaceDialog(created?.id ?? route.spaceId)
        }}
      />
      <RemoveWikiSpaceDialog
        space={spaceToRemove}
        busy={removingSpace}
        error={removeSpaceError}
        onClose={() => setSpaceToRemove(null)}
        onConfirm={() => void removeSpace()}
      />
      <DeleteWikiPageDialog
        page={pageToDelete}
        pageCount={
          pageToDelete
            ? pages.filter((page) => page.slug === pageToDelete.slug || page.slug.startsWith(`${pageToDelete.slug}/`))
                .length
            : 0
        }
        busy={deletingSlug !== null}
        error={pageDeleteError}
        onClose={() => setPageToDelete(null)}
        onConfirm={() => {
          if (pageToDelete) void deletePage(pageToDelete)
        }}
      />
      <WikiPageHistoryDialog
        space={activeSpace}
        page={historyPage}
        onClose={() => setHistoryPage(null)}
        loadHistory={getWikiPageHistory}
        onUndoLearning={async (revision) => {
          const currentPage = historyPage ? (pages.find((page) => page.slug === historyPage.slug) ?? historyPage) : null
          if (!currentPage?.revision) throw new Error('wiki-revision-required')
          const next = await window.remember.undoWikiLearning({
            spaceId: activeSpace.id,
            slug: currentPage.slug,
            revisionId: revision.id,
            expectedRevision: currentPage.revision,
          })
          await local.refresh()
          setHistoryPage(next.find((page) => page.slug === currentPage.slug) ?? null)
          setEditorGeneration((current) => current + 1)
        }}
        onRestore={async (revision) => {
          const currentPage = historyPage ? (pages.find((page) => page.slug === historyPage.slug) ?? historyPage) : null
          if (!currentPage?.revision) throw new Error('wiki-revision-required')
          const next = await restoreWikiPageRevision({
            spaceId: activeSpace.id,
            slug: currentPage.slug,
            revisionId: revision.id,
            expectedRevision: currentPage.revision,
          })
          const restored = next.find((page) => page.slug === currentPage.slug)
          if (restored) {
            setHistoryPage(restored)
            setEditorGeneration((current) => current + 1)
          }
        }}
      />
      <MoveWikiProjectDialog
        open={projectDialog !== null}
        sourceSpaceId={projectDialog?.sourceSpaceId ?? activeSpace.id}
        initialProjectSlug={projectDialog?.projectSlug}
        initialDestinationSpaceId={projectDialog?.destinationSpaceId}
        projects={(wikiBySpace[projectDialog?.sourceSpaceId ?? activeSpace.id] ?? []).filter((page) =>
          /^projects\/[^/]+$/.test(page.slug)
        )}
        sourcePages={wikiBySpace[projectDialog?.sourceSpaceId ?? activeSpace.id] ?? []}
        spaces={wikiOverview.spaces.filter((space) => space.id !== (projectDialog?.sourceSpaceId ?? activeSpace.id))}
        onClose={() => setProjectDialog(null)}
        onMove={async (input) => {
          try {
            await editorFlushRef.current?.()
            projectMoveTargetRef.current = { spaceId: input.destinationSpaceId, slug: input.projectSlug }
            await local.moveWikiProject(input)
            router.replace(wikiPageHref(input.destinationSpaceId, input.projectSlug))
            setProjectDialog(null)
          } catch (error) {
            projectMoveTargetRef.current = null
            throw error
          }
        }}
      />
    </>
  )

  if (selected) {
    const isProjectRoot = /^projects\/[^/]+$/.test(selected.slug)
    const createSelectedSubpage = () => void createPageInCategory(selected.slug.split('/')[0], selected.slug)
    const openHistory = () =>
      void (async () => {
        try {
          await editorFlushRef.current?.()
          setHistoryPage(selected)
        } catch {
          setWikiError(t('De laatste wijzigingen konden niet worden opgeslagen.'))
        }
      })()

    return (
      <>
        {breadcrumb({
          page: selected,
          onCreateSubpage: createSelectedSubpage,
          onDelete: () => {
            setPageDeleteError(null)
            setPageToDelete(selected)
          },
          onHistory: openHistory,
          ...(isProjectRoot
            ? {
                onMoveProject: hasProjectMoveDestination
                  ? () => setProjectDialog({ sourceSpaceId: activeSpace.id, projectSlug: selected.slug })
                  : undefined,
              }
            : {}),
        })}
        <WikiEditor
          key={`${activeSpace.id}:${selected.slug}:${editorGeneration}`}
          spaceId={activeSpace.id}
          page={selected}
          onSave={saveWikiPage}
          onReload={async () => {
            await selectWikiSpace(activeSpace.id)
            setEditorGeneration((current) => current + 1)
          }}
          onRegisterFlush={registerEditorFlush}
          startWithBlankTitle={selected.slug === newPage?.slug}
          subpages={wikiDirectChildren(pages, selected.slug)}
          creationError={creationError}
        />
        {dialogs}
      </>
    )
  }

  if (selectedCategory) {
    return (
      <>
        {breadcrumb({
          category: selectedCategory,
          onCreatePage: () => void createPageInCategory(selectedCategory.slug),
        })}
        <WikiCategoryPage
          spaceId={activeSpace.id}
          category={selectedCategory}
          pages={wikiRootPages(pages, selectedCategory.slug)}
          allPages={pages}
          creationError={creationError}
          onCreatePage={() => void createPageInCategory(selectedCategory.slug)}
        />
        {dialogs}
      </>
    )
  }

  if (route.kind === 'suggestions') {
    return (
      <>
        {breadcrumb({ suggestions: true })}
        <WikiSuggestions
          space={activeSpace}
          suggestions={suggestions}
          onApplySuggestion={(suggestion) =>
            local.applyKnowledgeSuggestion({
              suggestionId: suggestion.id,
              destinationSpaceId: suggestion.suggestedSpaceId,
            })
          }
          onDismissSuggestion={(suggestion) => local.dismissKnowledgeSuggestion({ suggestionId: suggestion.id })}
        />
        {dialogs}
      </>
    )
  }

  return (
    <>
      {breadcrumb(route.kind === 'home' ? { onOpenSettings: () => setSettingsOpen(true) } : undefined)}
      <WikiHome
        key={activeSpace.id}
        space={activeSpace}
        pages={pages}
        creationError={creationError}
        suggestionCount={suggestions.length}
        onAddProject={
          activeSpace.id !== PERSONAL_WIKI_SPACE_ID && pages.length === 0
            ? () =>
                setProjectDialog({
                  sourceSpaceId: PERSONAL_WIKI_SPACE_ID,
                  destinationSpaceId: activeSpace.id,
                })
            : undefined
        }
      />
      {dialogs}
    </>
  )
}

function WikiBreadcrumb({
  space,
  pages,
  suggestions = false,
  category,
  page,
  settingsOpen,
  onRemoveSpace,
  onCreatePage,
  onCreateSubpage,
  onDelete,
  onHistory,
  onMoveProject,
  onOpenSettings,
  creatingPage = false,
  creatingSubpage = false,
  deleting = false,
  syncing = false,
}: {
  space: WikiSpace
  pages: WikiPage[]
  syncing?: boolean
  suggestions?: boolean
  category?: WikiCategory
  page?: WikiPage
  settingsOpen: boolean
  onRemoveSpace: () => void
  onCreatePage?: () => void
  onCreateSubpage?: () => void
  onDelete?: () => void
  onHistory?: () => void
  onMoveProject?: () => void
  onOpenSettings?: () => void
  creatingPage?: boolean
  creatingSubpage?: boolean
  deleting?: boolean
}) {
  const { t } = useI18n()
  const pageCategory = page ? categoryForSlug(page.slug, pages) : undefined
  const visibleCategory = category ?? pageCategory
  const ancestors = page ? wikiAncestors(page, pages) : []
  const deletesProjectTree = Boolean(
    page && /^projects\/[^/]+$/.test(page.slug) && pages.some((candidate) => candidate.slug.startsWith(`${page.slug}/`))
  )
  const currentTitle =
    page?.title ?? (visibleCategory ? t(visibleCategory.label) : suggestions ? t('Voorstellen') : space.name)

  return (
    <DashboardPageHeader>
      <header className="flex min-h-[43px] items-center justify-between gap-3 border-slate-200 border-b px-3">
        <nav aria-label={t('Wiki-kruimelpad')} className="min-w-0">
          <ol className="flex min-w-0 items-center gap-0.5 text-slate-800 text-sm">
            <li className="shrink-0">
              {onOpenSettings && !suggestions && !visibleCategory && !page ? (
                <button
                  type="button"
                  aria-current="page"
                  aria-haspopup="dialog"
                  aria-expanded={settingsOpen}
                  title={t('Space-instellingen')}
                  onClick={onOpenSettings}
                  className="flex h-7 max-w-52 cursor-pointer items-center gap-1.5 rounded-md px-1.5 font-medium text-slate-800 outline-none transition-[background-color,transform] duration-150 ease-out hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-slate-400 active:scale-[0.97] motion-reduce:transition-none"
                >
                  <WikiSpaceGlyph icon={space.icon} color={space.color} className="size-3.5" />
                  <span className="min-w-0 truncate">{space.name}</span>
                </button>
              ) : (
                <Link
                  href={wikiHomeHref(space.id)}
                  className="flex h-7 max-w-52 items-center gap-1.5 rounded-md px-1.5 font-medium text-slate-800 outline-none transition-[background-color,transform] duration-150 ease-out hover:bg-slate-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-slate-400 active:scale-[0.97] motion-reduce:transition-none"
                >
                  <WikiSpaceGlyph icon={space.icon} color={space.color} className="size-3.5" />
                  <span className="min-w-0 truncate">{space.name}</span>
                </Link>
              )}
            </li>
            {suggestions ? (
              <>
                <BreadcrumbSeparator />
                <li aria-current="page" className="min-w-0">
                  <span className="flex h-7 items-center truncate px-1.5 font-medium text-slate-800">
                    {t('Voorstellen')}
                  </span>
                </li>
              </>
            ) : null}
            {visibleCategory ? (
              <>
                <BreadcrumbSeparator />
                <li className="min-w-0">
                  {page ? (
                    <Link
                      href={wikiCategoryHref(space.id, visibleCategory.slug)}
                      className="flex h-7 max-w-40 items-center truncate rounded-md px-1.5 font-medium text-slate-800 outline-none transition-[background-color,color,transform] duration-150 ease-out hover:bg-slate-100 hover:text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-slate-400 active:scale-[0.97] motion-reduce:transition-none"
                    >
                      {t(visibleCategory.label)}
                    </Link>
                  ) : (
                    <span className="flex h-7 items-center truncate px-1.5 font-medium text-slate-800">
                      {t(visibleCategory.label)}
                    </span>
                  )}
                </li>
              </>
            ) : null}
            {ancestors.map((ancestor) => (
              <Fragment key={ancestor.slug}>
                <BreadcrumbSeparator />
                <li className="min-w-0">
                  <Link
                    href={wikiPageHref(space.id, ancestor.slug)}
                    className="flex h-7 max-w-40 items-center truncate rounded-md px-1.5 font-medium text-slate-800 outline-none transition-[background-color,color,transform] duration-150 ease-out hover:bg-slate-100 hover:text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-slate-400 active:scale-[0.97] motion-reduce:transition-none"
                  >
                    {ancestor.title}
                  </Link>
                </li>
              </Fragment>
            ))}
            {page ? (
              <>
                <BreadcrumbSeparator />
                <li className="min-w-0">
                  <span className="flex h-7 max-w-[32rem] items-center truncate px-1.5 font-medium text-slate-800">
                    {page.title}
                  </span>
                </li>
              </>
            ) : null}
          </ol>
        </nav>
        <div className="flex shrink-0 items-center gap-1">
          {syncing ? (
            <span role="status" className="flex h-7 items-center gap-1.5 px-1.5 text-slate-500 text-xs">
              <Spinner size="xs" />
              {t('Wiki opbouwen…')}
            </span>
          ) : null}
          {space.id !== PERSONAL_WIKI_SPACE_ID ||
          onCreatePage ||
          onCreateSubpage ||
          onDelete ||
          onHistory ||
          onMoveProject ? (
            <Menu>
              <MenuButton
                as={IconButton}
                disabled={creatingPage || creatingSubpage || deleting}
                aria-label={t('Meer opties voor {title}', { title: currentTitle })}
                title={t('Meer opties voor {title}', { title: currentTitle })}
                className="cursor-pointer"
              >
                <IconDotGrid1x3HorizontalTight className="size-3.5" aria-hidden="true" />
              </MenuButton>
              <DropdownMenuItems anchor="bottom end" className="mt-1 w-48 origin-top-right">
                {onCreatePage ? (
                  <MenuItem>
                    <button
                      type="button"
                      onClick={onCreatePage}
                      disabled={creatingPage}
                      className={`${dropdownItemStyle} disabled:cursor-wait disabled:text-slate-400`}
                    >
                      <IconPlusSmall className="size-4" aria-hidden="true" />
                      {t('Nieuwe pagina')}
                    </button>
                  </MenuItem>
                ) : null}
                {onCreateSubpage ? (
                  <MenuItem>
                    <button
                      type="button"
                      onClick={onCreateSubpage}
                      disabled={creatingSubpage}
                      className={`${dropdownItemStyle} disabled:cursor-wait disabled:text-slate-400`}
                    >
                      <IconPlusSmall className="size-4" aria-hidden="true" />
                      {t('Nieuwe subpagina')}
                    </button>
                  </MenuItem>
                ) : null}
                {onMoveProject ? (
                  <MenuItem>
                    <button type="button" onClick={onMoveProject} className={dropdownItemStyle}>
                      <IconArrowRight className="size-4" aria-hidden="true" />
                      {t('Project verplaatsen…')}
                    </button>
                  </MenuItem>
                ) : null}
                {onHistory ? (
                  <MenuItem>
                    <button type="button" onClick={onHistory} className={dropdownItemStyle}>
                      <IconHistory className="size-4" aria-hidden="true" />
                      {t('Paginageschiedenis')}
                    </button>
                  </MenuItem>
                ) : null}
                {onDelete || space.id !== PERSONAL_WIKI_SPACE_ID ? (
                  <hr className="my-1 border-black/[0.07] border-t" />
                ) : null}
                {onDelete ? (
                  <MenuItem>
                    <button
                      type="button"
                      onClick={onDelete}
                      disabled={deleting}
                      className={`${dropdownDangerItemStyle} disabled:cursor-wait disabled:text-slate-400`}
                    >
                      <IconTrashCanSimple className="size-4" aria-hidden="true" />
                      {deleting
                        ? t('Verwijderen…')
                        : deletesProjectTree
                          ? t('Project verwijderen')
                          : t('Pagina verwijderen')}
                    </button>
                  </MenuItem>
                ) : null}
                {space.id !== PERSONAL_WIKI_SPACE_ID ? (
                  <MenuItem>
                    <button
                      type="button"
                      onClick={onRemoveSpace}
                      className={`${dropdownDangerItemStyle} disabled:cursor-not-allowed disabled:text-slate-400`}
                    >
                      <IconTrashCanSimple className="size-4" aria-hidden="true" />
                      {t('Space verwijderen')}
                    </button>
                  </MenuItem>
                ) : null}
              </DropdownMenuItems>
            </Menu>
          ) : null}
        </div>
      </header>
    </DashboardPageHeader>
  )
}

function WikiHome({
  space,
  pages,
  creationError,
  suggestionCount,
  onAddProject,
}: {
  space: WikiSpace
  pages: WikiPage[]
  creationError: string | null
  suggestionCount: number
  onAddProject?: () => void
}) {
  const { t } = useI18n()
  const recentPages = useMemo(() => sortByRecent(pages).slice(0, 6), [pages])

  return (
    <div className="mx-auto w-full max-w-[800px] px-6 py-10 sm:px-10 md:py-12">
      <div className="grid gap-6">
        <WikiSpaceHeader space={space} suggestionCount={suggestionCount} />

        {onAddProject ? (
          <section className="flex items-center justify-between gap-4 rounded-lg bg-slate-50 px-3 py-2.5">
            <div className="min-w-0">
              <h2 className="font-medium text-slate-900 text-sm">{t('Begin met een bestaand project')}</h2>
              <p className="mt-0.5 text-slate-500 text-xs">{t('Verplaats een volledig project naar deze space.')}</p>
            </div>
            <Button variant="outline" color="secondary" onClick={onAddProject}>
              {t('Project toevoegen')}
            </Button>
          </section>
        ) : null}

        <section aria-labelledby="wiki-categories-title" className="grid gap-3">
          <h2 id="wiki-categories-title" className="font-semibold text-slate-900 text-md">
            {t('Categorieën')}
          </h2>
          <div className="grid gap-2 sm:grid-cols-2">
            {wikiCategories(pages).map((category) => {
              const count = wikiCategoryCount(pages, category.slug)
              return (
                <Link
                  key={category.slug}
                  href={wikiCategoryHref(space.id, category.slug)}
                  className="group min-w-0 rounded-lg border border-black/[0.07] bg-white p-3 outline-none transition-[background-color,border-color] duration-150 ease-out hover:border-black/[0.1] hover:bg-slate-50/70 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 motion-reduce:transition-none"
                >
                  <span className="flex items-center justify-between gap-3">
                    <span className="font-medium text-slate-900 text-ui">{t(category.label)}</span>
                    <span className="shrink-0 text-slate-600 text-xs tabular-nums">{count}</span>
                  </span>
                </Link>
              )
            })}
          </div>
          {creationError ? (
            <p className="text-danger-700 text-sm" role="alert">
              {creationError}
            </p>
          ) : null}
        </section>

        <WikiPageSection
          spaceId={space.id}
          title={t('Recent')}
          pages={recentPages}
          allPages={pages}
          emptyMessage={t('Nieuwe wiki-pagina’s verschijnen hier zodra er kennis is vastgelegd.')}
        />
      </div>
    </div>
  )
}

function WikiSpaceHeader({ space, suggestionCount }: { space: WikiSpace; suggestionCount: number }) {
  const { t } = useI18n()

  return (
    <header>
      <div className="flex min-w-0 items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <WikiSpaceBadge icon={space.icon} color={space.color} className="size-9 rounded-lg" iconClassName="size-6" />
          <h1 className="min-w-0 truncate font-display font-semibold text-2xl text-slate-950 tracking-[-0.025em]">
            {space.name}
          </h1>
        </div>
        <Link
          href={wikiSuggestionsHref(space.id)}
          className="relative flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 font-medium text-slate-600 text-sm outline-none transition-[background-color,color,transform] duration-150 ease-out before:absolute before:-inset-y-1 before:inset-x-0 before:content-[''] hover:bg-slate-100 hover:text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 active:scale-[0.97] motion-reduce:transition-none"
        >
          <span className="relative">{t('Voorstellen')}</span>
          {suggestionCount > 0 ? (
            <span className="inline-flex size-5 items-center justify-center rounded-full bg-slate-100 font-semibold text-[11px] text-slate-700 leading-none tabular-nums">
              {suggestionCount}
            </span>
          ) : null}
          {suggestionCount > 0 ? <span className="sr-only">{t('Onbeoordeelde voorstellen')}</span> : null}
          <IconArrowRight className="size-3.5" aria-hidden="true" />
        </Link>
      </div>
      {space.description ? <p className="mt-4 text-md text-slate-500 leading-6">{space.description}</p> : null}
    </header>
  )
}

function WikiSuggestions({
  space,
  suggestions,
  onApplySuggestion,
  onDismissSuggestion,
}: {
  space: WikiSpace
  suggestions: KnowledgeSuggestion[]
  onApplySuggestion: (suggestion: KnowledgeSuggestion) => Promise<WikiOverview>
  onDismissSuggestion: (suggestion: KnowledgeSuggestion) => Promise<WikiOverview>
}) {
  const { t } = useI18n()
  const [applied, setApplied] = useState<KnowledgeSuggestion | null>(null)

  return (
    <div className="mx-auto w-full max-w-[800px] px-6 py-10 sm:px-10 md:py-12">
      <div className="grid gap-6">
        <header className="grid justify-items-start gap-2">
          <Link
            href={wikiHomeHref(space.id)}
            className="relative -ml-2 flex h-8 items-center gap-1 rounded-md px-2 font-medium text-slate-500 text-sm outline-none transition-[background-color,color,transform] duration-150 ease-out before:absolute before:-inset-y-1 before:inset-x-0 before:content-[''] hover:bg-slate-100 hover:text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 active:scale-[0.97] motion-reduce:transition-none"
          >
            <IconArrowLeft className="size-3.5" aria-hidden="true" />
            {t('Terug')}
          </Link>
          <h1 className="min-w-0 text-balance font-display font-semibold text-2xl text-slate-950 leading-[1.15] tracking-[-0.025em]">
            {t('Voorstellen')}
          </h1>
        </header>
        {applied ? (
          <p role="status" className="text-slate-600 text-sm">
            <Link
              className="font-medium underline decoration-slate-300 underline-offset-2"
              href={wikiPageHref(space.id, applied.slug)}
            >
              {applied.title}
            </Link>
            {' · '}
            {t('Opgeslagen in deze space.')}
          </p>
        ) : null}
        {suggestions.length > 0 ? (
          <WikiProposalQueue
            space={space}
            suggestions={suggestions}
            onApply={async (suggestion) => {
              const overview = await onApplySuggestion(suggestion)
              setApplied(suggestion)
              return overview
            }}
            onDismiss={onDismissSuggestion}
          />
        ) : (
          <section className="rounded-xl border border-black/[0.08] bg-white px-6 py-12 text-center">
            <p className="text-slate-500 text-sm">{t('Geen Wiki-wijzigingen om te beoordelen.')}</p>
          </section>
        )}
      </div>
    </div>
  )
}

function WikiProposalQueue({
  space,
  suggestions,
  onApply,
  onDismiss,
}: {
  space: WikiSpace
  suggestions: KnowledgeSuggestion[]
  onApply: (suggestion: KnowledgeSuggestion) => Promise<WikiOverview>
  onDismiss: (suggestion: KnowledgeSuggestion) => Promise<WikiOverview>
}) {
  const { t } = useI18n()
  const local = useLocalBridge()
  const [selected, setSelected] = useState<KnowledgeSuggestion | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const currentPage = selected ? local.wikiBySpace[space.id]?.find((page) => page.slug === selected.slug) : null

  async function apply() {
    if (!selected || busyId) return
    setBusyId(selected.id)
    setError(null)
    try {
      await onApply(selected)
      setSelected(null)
    } catch (applyError) {
      setError(
        applyError instanceof Error && applyError.message.includes('knowledge-suggestion-stale')
          ? t('De pagina is intussen gewijzigd. Dit voorstel is niet meer veilig toe te passen.')
          : t('Het voorstel kon niet worden toegepast.')
      )
    } finally {
      setBusyId(null)
    }
  }

  async function dismiss(suggestion: KnowledgeSuggestion) {
    if (busyId) return
    setBusyId(suggestion.id)
    setError(null)
    try {
      await onDismiss(suggestion)
      if (selected?.id === suggestion.id) setSelected(null)
    } catch {
      setError(t('Het voorstel kon niet worden afgewezen.'))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <section aria-label={t('Voorstellen')} className="grid gap-2">
      <ul className="divide-y divide-black/[0.06] overflow-hidden rounded-lg border border-black/[0.08] bg-white">
        {suggestions.map((suggestion) => (
          <li key={suggestion.id} className="flex items-center gap-3 px-3 py-2.5">
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium text-slate-900 text-sm">{suggestion.title}</p>
              <p className="mt-0.5 line-clamp-2 text-slate-500 text-xs leading-4">{suggestion.summary}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button
                size="small"
                variant="text"
                color="secondary"
                disabled={Boolean(busyId)}
                onClick={() => void dismiss(suggestion)}
              >
                {t('Afwijzen')}
              </Button>
              <Button
                size="small"
                variant="outline"
                color="secondary"
                disabled={Boolean(busyId)}
                onClick={() => {
                  setError(null)
                  setSelected(suggestion)
                }}
              >
                {t('Bekijken')}
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {error && !selected ? (
        <p className="text-danger-700 text-xs" role="alert">
          {error}
        </p>
      ) : null}

      <Dialog
        open={Boolean(selected)}
        onClose={busyId ? () => undefined : () => setSelected(null)}
        className="app-no-drag relative z-50"
      >
        <DialogBackdrop
          transition
          className="fixed inset-0 bg-modal-backdrop backdrop-blur-[1px] transition-opacity data-[closed]:opacity-0 motion-reduce:transition-none ease-[cubic-bezier(0.215,0.61,0.355,1)] data-[leave]:ease-out duration-(--modal-enter-duration) data-[leave]:duration-(--modal-exit-duration)"
        />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <DialogPanel
            transition
            className="flex max-h-[min(760px,calc(100vh-2rem))] w-full max-w-2xl origin-center flex-col overflow-hidden rounded-xl bg-white shadow-raised transition-[opacity,scale] data-[closed]:scale-[0.98] data-[closed]:opacity-0 motion-reduce:transition-none ease-[cubic-bezier(0.215,0.61,0.355,1)] data-[leave]:ease-out duration-(--modal-enter-duration) data-[leave]:duration-(--modal-exit-duration)"
          >
            <header className="flex items-start justify-between gap-4 border-slate-100 border-b px-4 py-3.5">
              <div className="min-w-0">
                <DialogTitle className="truncate font-semibold text-slate-950 text-md">{selected?.title}</DialogTitle>
                <DialogDescription className="mt-0.5 text-slate-500 text-xs">
                  {t('Voorstel voor {space}', { space: space.name })}
                </DialogDescription>
              </div>
              <IconButton aria-label={t('Sluiten')} onClick={() => setSelected(null)} disabled={Boolean(busyId)}>
                <IconCrossSmall className="size-4" aria-hidden="true" />
              </IconButton>
            </header>
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              <p className="mb-3 text-slate-600 text-sm">{selected?.summary}</p>
              <WikiEvidence evidence={selected?.evidence} />
              {currentPage ? (
                <details className="mb-4 rounded-lg border border-slate-200 p-3 text-slate-500 text-xs">
                  <summary className="w-fit cursor-pointer rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-slate-400">
                    {t('Huidige versie bekijken')}
                  </summary>
                  <MarkdownContent className="mt-3" wikiSpaceId={space.id}>
                    {currentPage.content}
                  </MarkdownContent>
                </details>
              ) : null}
              <p className="mb-2 font-medium text-slate-600 text-xs">
                {currentPage ? t('Voorgestelde versie') : t('Nieuwe pagina')}
              </p>
              <MarkdownContent className="wiki-proposal-content [&>:first-child]:mt-0" wikiSpaceId={space.id}>
                {selected?.content ?? ''}
              </MarkdownContent>
            </div>
            <footer className="border-slate-100 border-t px-4 py-3">
              {error ? (
                <p className="mb-2 text-danger-700 text-xs" role="alert">
                  {error}
                </p>
              ) : null}
              <div className="flex justify-end gap-2">
                <Button
                  size="small"
                  variant="text"
                  color="secondary"
                  disabled={Boolean(busyId)}
                  onClick={() => selected && void dismiss(selected)}
                >
                  {t('Afwijzen')}
                </Button>
                <Button size="small" disabled={Boolean(busyId)} onClick={() => void apply()}>
                  {busyId ? t('Toepassen…') : t('Voorstel toepassen')}
                </Button>
              </div>
            </footer>
          </DialogPanel>
        </div>
      </Dialog>
    </section>
  )
}

function WikiSettingsDialog({
  open,
  space,
  onClose,
  onUpdateSpace,
}: {
  open: boolean
  space: WikiSpace
  onClose: () => void
  onUpdateSpace: (input: UpdateWikiSpaceInput) => Promise<WikiOverview>
}) {
  const { t } = useI18n()
  const [name, setName] = useState(space.name)
  const [description, setDescription] = useState(space.description)
  const [icon, setIcon] = useState(space.icon)
  const [color, setColor] = useState(space.color)
  const [maintenanceMode, setMaintenanceMode] = useState(space.maintenanceMode)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const normalizedName = name.replace(/\s+/g, ' ').trim()
  const normalizedDescription = description.replace(/\s+/g, ' ').trim()
  const hasChanges =
    normalizedName !== space.name ||
    normalizedDescription !== space.description ||
    icon !== space.icon ||
    color !== space.color ||
    maintenanceMode !== space.maintenanceMode

  useEffect(() => {
    if (!open) return
    setName(space.name)
    setDescription(space.description)
    setIcon(space.icon)
    setColor(space.color)
    setMaintenanceMode(space.maintenanceMode)
    setError(null)
  }, [open, space.color, space.description, space.icon, space.maintenanceMode, space.name])

  async function saveSettings() {
    if (saving || !normalizedName || !hasChanges) return
    setSaving(true)
    setError(null)
    try {
      await onUpdateSpace({
        spaceId: space.id,
        name: normalizedName,
        description: normalizedDescription,
        icon,
        color,
        maintenanceMode,
      })
      onClose()
    } catch {
      setError(t('De Space-instellingen konden niet worden opgeslagen.'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onClose={saving ? () => undefined : onClose} className="app-no-drag relative z-50">
      <DialogBackdrop
        transition
        className="fixed inset-0 bg-modal-backdrop backdrop-blur-[1px] transition-opacity data-[closed]:opacity-0 motion-reduce:transition-none ease-[cubic-bezier(0.215,0.61,0.355,1)] data-[leave]:ease-out duration-(--modal-enter-duration) data-[leave]:duration-(--modal-exit-duration)"
      />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel
          transition
          className="w-full max-w-md origin-center overflow-hidden rounded-xl bg-white shadow-raised transition-[opacity,scale] data-[closed]:scale-[0.98] data-[closed]:opacity-0 motion-reduce:transition-none ease-[cubic-bezier(0.215,0.61,0.355,1)] data-[leave]:ease-out duration-(--modal-enter-duration) data-[leave]:duration-(--modal-exit-duration)"
        >
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void saveSettings()
            }}
          >
            <header className="flex items-center justify-between gap-4 border-slate-100 border-b px-4 py-3.5">
              <DialogTitle className="font-semibold text-slate-950 text-md">{t('Space-instellingen')}</DialogTitle>
              <IconButton aria-label={t('Sluiten')} onClick={onClose} disabled={saving}>
                <IconCrossSmall className="size-4" aria-hidden="true" />
              </IconButton>
            </header>

            <div className="grid gap-4 p-4">
              <div className="flex items-end gap-3">
                <WikiSpaceAppearancePicker
                  space={{ ...space, icon, color }}
                  saving={saving}
                  onChange={(patch) => {
                    if (patch.icon) setIcon(patch.icon)
                    if (patch.color) setColor(patch.color)
                  }}
                />
                <div className="grid min-w-0 flex-1 gap-1.5">
                  <label htmlFor={`wiki-settings-name-${space.id}`} className="font-medium text-slate-700 text-sm">
                    {t('Naam')}
                  </label>
                  <input
                    id={`wiki-settings-name-${space.id}`}
                    value={name}
                    maxLength={80}
                    autoFocus
                    autoComplete="off"
                    spellCheck={false}
                    disabled={saving}
                    onChange={(event) => setName(event.target.value)}
                    className="h-9 rounded-lg border border-black/[0.08] bg-white px-3 text-slate-900 text-ui outline-none placeholder:text-slate-400 focus:border-slate-300 focus:ring-2 focus:ring-slate-200 disabled:bg-slate-50 disabled:text-slate-400"
                  />
                </div>
              </div>

              <div className="grid gap-1.5">
                <label htmlFor={`wiki-settings-description-${space.id}`} className="font-medium text-slate-700 text-sm">
                  {t('Beschrijving')}
                </label>
                <textarea
                  id={`wiki-settings-description-${space.id}`}
                  value={description}
                  maxLength={280}
                  rows={3}
                  disabled={saving}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder={t('Waar gaat deze Space over?')}
                  className="resize-none rounded-lg border border-black/[0.08] bg-white px-3 py-2 text-slate-900 text-ui leading-5 outline-none placeholder:text-slate-400 focus:border-slate-300 focus:ring-2 focus:ring-slate-200 disabled:bg-slate-50 disabled:text-slate-400"
                />
              </div>

              <section className="flex flex-wrap items-center justify-between gap-3 border-slate-100 border-t pt-4">
                <div className="min-w-0">
                  <h2 className="font-medium text-slate-900 text-sm">{t('AI-updates')}</h2>
                  <p className="mt-0.5 text-slate-500 text-xs">
                    {maintenanceMode === 'auto'
                      ? t('Remember verwerkt nieuwe kennis direct.')
                      : t('Remember wacht tot je een voorstel accepteert.')}
                  </p>
                </div>
                <div className="inline-flex rounded-md bg-slate-100 p-0.5" role="group" aria-label={t('AI-updates')}>
                  {(['auto', 'suggest'] as const).map((mode) => (
                    <button
                      key={mode}
                      type="button"
                      aria-pressed={maintenanceMode === mode}
                      disabled={saving}
                      onClick={() => setMaintenanceMode(mode)}
                      className={`h-7 rounded-[5px] px-2.5 font-medium text-sm outline-none transition-[background-color,color,box-shadow,transform] duration-150 ease-out focus-visible:ring-2 focus-visible:ring-slate-400 active:scale-[0.96] disabled:cursor-wait motion-reduce:transition-none ${
                        maintenanceMode === mode
                          ? 'bg-white text-slate-900 shadow-raised'
                          : 'text-slate-600 hover:text-slate-800'
                      }`}
                    >
                      {mode === 'auto' ? t('Automatisch') : t('Voorstellen')}
                    </button>
                  ))}
                </div>
              </section>

              {error ? (
                <p className="text-danger-700 text-sm" role="alert">
                  {error}
                </p>
              ) : null}
            </div>

            <footer className="flex justify-end gap-2 border-slate-100 border-t px-4 py-3">
              <Button size="small" variant="text" color="secondary" onClick={onClose} disabled={saving}>
                {t('Annuleren')}
              </Button>
              <Button size="small" type="submit" disabled={saving || !normalizedName || !hasChanges}>
                {saving ? t('Opslaan…') : t('Opslaan')}
              </Button>
            </footer>
          </form>
        </DialogPanel>
      </div>
    </Dialog>
  )
}

function WikiSpaceAppearancePicker({
  space,
  saving,
  onChange,
}: {
  space: WikiSpace
  saving: boolean
  onChange: (patch: Pick<UpdateWikiSpaceInput, 'icon' | 'color'>) => void
}) {
  const { t } = useI18n()
  return (
    <Popover className="relative shrink-0">
      <PopoverButton
        disabled={saving}
        aria-label={t('Icoon en kleur wijzigen')}
        title={t('Icoon en kleur wijzigen')}
        className="group rounded-lg outline-none transition-[filter,transform] duration-150 ease-out hover:brightness-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-400 active:scale-[0.96] disabled:cursor-wait disabled:opacity-60 motion-reduce:transition-none"
      >
        <WikiSpaceBadge icon={space.icon} color={space.color} className="size-9 rounded-lg" iconClassName="size-6" />
      </PopoverButton>
      <PopoverPanel
        anchor="bottom start"
        transition
        className="z-50 mt-2 w-[min(21.5rem,calc(100vw-2rem))] origin-top-left rounded-xl bg-white p-3 shadow-raised outline-none transition-[opacity,transform] duration-100 ease-out data-closed:scale-[0.98] data-closed:opacity-0 motion-reduce:transition-none"
      >
        <section aria-labelledby="wiki-space-icons-title">
          <h2 id="wiki-space-icons-title" className="px-1 font-medium text-slate-500 text-xs">
            {t('Icoon')}
          </h2>
          <div className="mt-2 grid grid-cols-6 gap-1">
            {wikiSpaceIconChoices.map((choice) => (
              <button
                key={choice.id}
                type="button"
                aria-label={t(choice.label)}
                aria-pressed={choice.id === space.icon}
                disabled={saving}
                onClick={() => onChange({ icon: choice.id })}
                className="group/icon flex size-8 items-center justify-center rounded-lg outline-none transition-transform duration-100 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-slate-400 active:scale-[0.94] disabled:cursor-wait motion-reduce:transition-none"
              >
                <span
                  className={`flex size-7 items-center justify-center rounded-md transition-colors duration-100 ease-out group-hover/icon:bg-slate-100 motion-reduce:transition-none ${
                    choice.id === space.icon ? 'bg-slate-100' : ''
                  }`}
                >
                  <WikiSpaceGlyph icon={choice.id} color={space.color} className="size-4" />
                </span>
              </button>
            ))}
          </div>
        </section>
        <div className="my-3 h-px bg-slate-100" />
        <section aria-labelledby="wiki-space-colors-title">
          <h2 id="wiki-space-colors-title" className="px-1 font-medium text-slate-500 text-xs">
            {t('Kleur')}
          </h2>
          <div className="mt-2 flex flex-wrap items-center gap-1">
            {wikiSpaceColorChoices.map((choice) => (
              <button
                key={choice.id}
                type="button"
                aria-label={t(choice.label)}
                aria-pressed={choice.id === space.color}
                disabled={saving}
                onClick={() => onChange({ color: choice.id })}
                className="flex size-8 items-center justify-center rounded-full outline-none transition-transform duration-100 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-slate-400 active:scale-[0.94] disabled:cursor-wait motion-reduce:transition-none"
              >
                <span
                  className={`size-[22px] rounded-full ${wikiSpaceColorSwatch(choice.id)} ${
                    choice.id === space.color ? 'ring-2 ring-slate-700 ring-offset-1 ring-offset-white' : ''
                  }`}
                  aria-hidden="true"
                />
              </button>
            ))}
          </div>
        </section>
      </PopoverPanel>
    </Popover>
  )
}

function WikiCategoryPage({
  spaceId,
  category,
  pages,
  allPages,
  creationError,
  onCreatePage,
}: {
  spaceId: string
  category: WikiCategory
  pages: WikiPage[]
  allPages: WikiPage[]
  creationError: string | null
  onCreatePage?: () => void
}) {
  const { t } = useI18n()
  const sortedPages = useMemo(() => sortByRecent(pages), [pages])

  return (
    <div className="mx-auto w-full max-w-[800px] px-6 py-10 sm:px-10 md:py-12">
      <div className="grid gap-6">
        <h1 className="min-w-0 text-balance font-display font-semibold text-2xl text-slate-950 leading-[1.15] tracking-[-0.025em]">
          {t(category.label)}
        </h1>

        {creationError ? (
          <p className="text-danger-700 text-sm" role="alert">
            {creationError}
          </p>
        ) : null}

        <WikiPageSection
          spaceId={spaceId}
          title={t(category.label)}
          titleHidden
          pages={sortedPages}
          allPages={allPages}
          emptyMessage={t('Er staan nog geen pagina’s in {category}.', {
            category: t(category.label).toLocaleLowerCase(),
          })}
        />
        {pages.length === 0 && onCreatePage ? (
          <Button size="small" className="w-fit" onClick={onCreatePage}>
            <IconPlusSmall className="size-4" aria-hidden="true" />
            {t('Nieuwe pagina')}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

function WikiPageSection({
  spaceId,
  title,
  titleHidden = false,
  pages,
  allPages = pages,
  emptyMessage,
}: {
  spaceId: string
  title: string
  titleHidden?: boolean
  pages: WikiPage[]
  allPages?: WikiPage[]
  emptyMessage: string
}) {
  const titleId = useId()

  return (
    <section aria-labelledby={titleId} className="grid gap-3">
      <h2 id={titleId} className={titleHidden ? 'sr-only' : 'font-semibold text-slate-900 text-md'}>
        {title}
      </h2>
      {pages.length ? (
        <ul className="grid gap-0.5">
          {pages.map((page) => {
            const source = spaceConversationSource(page, spaceId, allPages)
            const Icon = source ? IconMicrophone : IconFileText
            return (
              <li key={page.slug}>
                <Link
                  href={source?.href ?? wikiPageHref(spaceId, page.slug)}
                  className="-mx-3 flex min-h-10 min-w-0 items-center pointer-coarse:min-h-11 gap-2 rounded-lg px-3 py-2 font-medium text-slate-900 text-ui outline-none transition-colors duration-150 ease-out hover:bg-slate-100/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-slate-400 motion-reduce:transition-none"
                >
                  <Icon className="size-4 shrink-0 text-slate-400" aria-hidden="true" />
                  <span className="truncate">{page.title}</span>
                </Link>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="text-slate-500 text-sm">{emptyMessage}</p>
      )}
    </section>
  )
}

function MoveWikiProjectDialog({
  open,
  sourceSpaceId,
  initialProjectSlug,
  initialDestinationSpaceId,
  projects,
  sourcePages,
  spaces,
  onClose,
  onMove,
}: {
  open: boolean
  sourceSpaceId: string
  initialProjectSlug?: string
  initialDestinationSpaceId?: string
  projects: WikiPage[]
  sourcePages: WikiPage[]
  spaces: WikiSpace[]
  onClose: () => void
  onMove: (input: MoveWikiProjectInput) => Promise<void>
}) {
  const { t } = useI18n()
  const [projectSlug, setProjectSlug] = useState('')
  const [destinationSpaceId, setDestinationSpaceId] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const wasOpenRef = useRef(false)

  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false
      return
    }
    if (wasOpenRef.current) return
    wasOpenRef.current = true
    const nextProjectSlug = initialProjectSlug ?? projects[0]?.slug ?? ''
    setProjectSlug(nextProjectSlug)
    setDestinationSpaceId(initialDestinationSpaceId ?? spaces[0]?.id ?? '')
    setBusy(false)
    setError(null)
  }, [initialDestinationSpaceId, initialProjectSlug, open, projects, spaces])

  const selectedProject = projects.find((project) => project.slug === projectSlug) ?? null
  const selectedDestination = spaces.find((space) => space.id === destinationSpaceId) ?? null
  const projectPages = sourcePages.filter(
    (page) => page.slug === projectSlug || page.slug.startsWith(`${projectSlug}/`)
  )
  const canSubmit = Boolean(selectedProject && selectedDestination && projectPages.length && !busy)

  async function submit() {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      await onMove({ projectSlug, sourceSpaceId, destinationSpaceId })
    } catch (submitError) {
      setError(
        submitError instanceof Error && submitError.message.includes('wiki-project-move-conflict')
          ? t('De bestemming bevat al een of meer pagina’s op dezelfde plek. Er is niets verplaatst.')
          : t('Het project kon niet worden verplaatst.')
      )
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onClose={busy ? () => undefined : onClose} className="app-no-drag relative z-50">
      <DialogBackdrop
        transition
        className="fixed inset-0 bg-modal-backdrop backdrop-blur-[1px] transition-opacity data-[closed]:opacity-0 motion-reduce:transition-none ease-[cubic-bezier(0.215,0.61,0.355,1)] data-[leave]:ease-out duration-(--modal-enter-duration) data-[leave]:duration-(--modal-exit-duration)"
      />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel
          transition
          className="w-full max-w-lg origin-center overflow-hidden rounded-xl bg-white shadow-raised transition-[opacity,scale] data-[closed]:scale-[0.98] data-[closed]:opacity-0 motion-reduce:transition-none ease-[cubic-bezier(0.215,0.61,0.355,1)] data-[leave]:ease-out duration-(--modal-enter-duration) data-[leave]:duration-(--modal-exit-duration)"
        >
          <header className="flex items-start justify-between gap-4 border-slate-100 border-b px-4 py-3.5">
            <div>
              <DialogTitle className="font-semibold text-slate-950 text-md">{t('Project verplaatsen')}</DialogTitle>
              <DialogDescription className="mt-0.5 text-slate-500 text-xs">
                {t('Verplaats alle projectpagina’s naar één andere Wiki.')}
              </DialogDescription>
            </div>
            <IconButton aria-label={t('Sluiten')} onClick={onClose} disabled={busy}>
              <IconCrossSmall className="size-4" aria-hidden="true" />
            </IconButton>
          </header>

          <div className="grid gap-4 px-4 py-4">
            <div className="grid gap-1.5 font-medium text-slate-700 text-sm">
              <span>{t('Project')}</span>
              <DropdownSelect
                ariaLabel={t('Project')}
                value={projectSlug}
                options={projects.map((project) => project.slug)}
                formatLabel={(slug) => projects.find((project) => project.slug === slug)?.title ?? slug}
                disabled={Boolean(initialProjectSlug) || busy}
                className="h-9 w-full"
                onChange={setProjectSlug}
              />
            </div>

            <div className="grid gap-1.5 font-medium text-slate-700 text-sm">
              <span>{t('Wiki')}</span>
              <DropdownSelect
                ariaLabel={t('Wiki')}
                value={destinationSpaceId}
                options={spaces.map((space) => space.id)}
                formatLabel={(spaceId) => spaces.find((space) => space.id === spaceId)?.name ?? spaceId}
                disabled={Boolean(initialDestinationSpaceId) || busy}
                className="h-9 w-full"
                onChange={setDestinationSpaceId}
              />
            </div>

            {selectedDestination ? (
              <section className="rounded-lg bg-slate-50 px-3 py-2.5">
                <p className="font-medium text-slate-800 text-sm">
                  {selectedDestination.maintenanceMode === 'auto'
                    ? t('Remember werkt deze Wiki automatisch bij')
                    : t('Remember stelt wijzigingen eerst voor')}
                </p>
                <p className="mt-0.5 text-slate-500 text-xs leading-5">
                  {selectedDestination.maintenanceMode === 'auto'
                    ? t('Nieuwe kennis wordt direct in de pagina’s verwerkt.')
                    : t('Nieuwe kennis verandert pas iets nadat je het voorstel accepteert.')}
                </p>
              </section>
            ) : null}

            {projectPages.length ? (
              <section aria-labelledby="share-project-pages-title" className="rounded-lg bg-slate-50 px-3 py-2.5">
                <h3 id="share-project-pages-title" className="font-medium text-slate-700 text-xs">
                  {projectPages.length === 1
                    ? t('1 pagina wordt verplaatst')
                    : t('{count} pagina’s worden verplaatst', { count: projectPages.length })}
                </h3>
                <ul className="compact-scrollbar mt-1.5 grid max-h-36 gap-0.5 overflow-y-auto pr-1 text-slate-600 text-xs">
                  {projectPages.map((page) => (
                    <li key={page.slug} className="flex min-h-7 items-center gap-2 rounded-md px-1">
                      <IconFileText className="size-3.5 shrink-0 text-slate-400" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">{page.title}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : (
              <p className="text-slate-500 text-sm">{t('Er is geen project om te verplaatsen.')}</p>
            )}

            {selectedProject && selectedDestination ? (
              <p className="text-slate-600 text-xs leading-5">
                {t('{project} wordt volledig verplaatst naar {space}.', {
                  project: selectedProject.title,
                  space: selectedDestination.name,
                })}
              </p>
            ) : null}
            {error ? (
              <p className="text-danger-700 text-sm" role="alert">
                {error}
              </p>
            ) : null}
          </div>

          <footer className="flex justify-end gap-2 border-slate-100 border-t px-4 py-3">
            <Button variant="text" color="secondary" onClick={onClose} disabled={busy}>
              {t('Annuleren')}
            </Button>
            <Button onClick={() => void submit()} disabled={!canSubmit}>
              {busy
                ? t('Project wordt verplaatst…')
                : projectPages.length === 1
                  ? t('1 pagina verplaatsen')
                  : t('{count} pagina’s verplaatsen', { count: projectPages.length })}
            </Button>
          </footer>
        </DialogPanel>
      </div>
    </Dialog>
  )
}

function WikiPageHistoryDialog({
  space,
  page,
  onClose,
  loadHistory,
  onRestore,
  onUndoLearning,
}: {
  space: WikiSpace
  page: WikiPage | null
  onClose: () => void
  loadHistory: (input: { spaceId: string; slug: string }) => Promise<WikiPageHistory>
  onRestore: (revision: WikiPageRevision) => Promise<void>
  onUndoLearning: (revision: WikiPageRevision) => Promise<void>
}) {
  const { t, dateLocale } = useI18n()
  const [history, setHistory] = useState<WikiPageHistory | null>(null)
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(null)
  const [confirmingRevisionId, setConfirmingRevisionId] = useState<string | null>(null)
  const [restoring, setRestoring] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: An explicit retry reloads the selected page's history.
  useEffect(() => {
    if (!page) {
      setHistory(null)
      setSelectedRevisionId(null)
      setConfirmingRevisionId(null)
      setError(null)
      return
    }
    let cancelled = false
    setHistory(null)
    setError(null)
    void loadHistory({ spaceId: space.id, slug: page.slug })
      .then((next) => {
        if (cancelled) return
        setHistory(next)
        setSelectedRevisionId(next.headRevisionId ?? next.revisions[0]?.id ?? null)
      })
      .catch(() => {
        if (!cancelled) setError(t('De paginageschiedenis kon niet worden geladen.'))
      })
    return () => {
      cancelled = true
    }
  }, [loadHistory, loadAttempt, page, space.id, t])

  const selectedRevision =
    history?.revisions.find((revision) => revision.id === selectedRevisionId) ?? history?.revisions[0] ?? null
  const confirmingRevision = history?.revisions.find((revision) => revision.id === confirmingRevisionId) ?? null
  const undoingLearning = Boolean(confirmingRevision && confirmingRevision.id === history?.headRevisionId)
  const canUndoSelected = Boolean(
    selectedRevision?.id === history?.headRevisionId &&
      selectedRevision?.actor === 'remember' &&
      selectedRevision.evidence?.length
  )
  const dayFormatter = useMemo(() => new Intl.DateTimeFormat(dateLocale, { dateStyle: 'medium' }), [dateLocale])
  const timeFormatter = useMemo(() => new Intl.DateTimeFormat(dateLocale, { timeStyle: 'short' }), [dateLocale])

  function actorName(revision: WikiPageRevision) {
    return wikiRevisionActor(revision, t)
  }

  function actorLabel(revision: WikiPageRevision) {
    if (revision.actor === 'remember') return t('Remember bewerkte')
    if (revision.actor === 'user') return t('Jij bewerkte')
    return actorName(revision)
  }

  async function restore(revision: WikiPageRevision) {
    if (!page || restoring) return
    setRestoring(true)
    setConfirmingRevisionId(null)
    setError(null)
    try {
      if (revision.id === history?.headRevisionId) {
        await onUndoLearning(revision)
        return
      }
      await onRestore(revision)
      const next = await loadHistory({ spaceId: space.id, slug: page.slug })
      setHistory(next)
      setSelectedRevisionId(next.headRevisionId)
    } catch (restoreError) {
      setError(
        restoreError instanceof Error && restoreError.message.includes('wiki-page-conflict')
          ? t('De pagina is intussen gewijzigd. Open de geschiedenis opnieuw.')
          : restoreError instanceof Error && restoreError.message.includes('wiki-learning-has-child-pages')
            ? t('Deze pagina bevat inmiddels subpagina’s. Pas de kennis aan in de editor.')
            : t('Deze versie kon niet worden hersteld.')
      )
    } finally {
      setRestoring(false)
    }
  }

  return (
    <Dialog open={Boolean(page)} onClose={restoring ? () => undefined : onClose} className="app-no-drag relative z-50">
      <DialogBackdrop
        transition
        className="fixed inset-0 bg-modal-backdrop backdrop-blur-[1px] transition-opacity duration-150 ease-out data-[closed]:opacity-0 motion-reduce:transition-none"
      />
      <div className="fixed inset-0 flex justify-end">
        <DialogPanel
          transition
          className="grid h-full w-full max-w-[1120px] origin-right grid-rows-[auto_minmax(0,1fr)] bg-white shadow-raised transition-[opacity,translate] data-[closed]:translate-x-3 data-[closed]:opacity-0 motion-reduce:transition-none ease-[cubic-bezier(0.215,0.61,0.355,1)] data-[leave]:ease-out duration-(--modal-enter-duration) data-[leave]:duration-(--modal-exit-duration)"
        >
          <div className="flex min-h-14 items-center justify-between border-black/[0.06] border-b px-5">
            <div className="min-w-0 py-3">
              <DialogTitle className="font-semibold text-slate-950 text-md">{t('Bijdragen')}</DialogTitle>
              <DialogDescription className="mt-0.5 truncate text-slate-500 text-xs">
                {history?.revisions.find((revision) => revision.id === history.headRevisionId)?.title ?? page?.title}
              </DialogDescription>
            </div>
            <IconButton size="compact" aria-label={t('Sluiten')} onClick={onClose} disabled={restoring}>
              <IconCrossSmall className="size-4" aria-hidden="true" />
            </IconButton>
          </div>

          {history?.revisions.length ? (
            <div className="grid min-h-0 md:grid-cols-[340px_minmax(0,1fr)]">
              <div className="custom-scrollbar custom-scrollbar-auto-gutter min-h-0 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain border-black/[0.06] border-b px-4 py-3 md:border-r md:border-b-0">
                <ol className="grid w-full min-w-0 gap-0.5 overflow-hidden">
                  {history.revisions.map((revision, index) => {
                    const selected = revision.id === selectedRevision?.id
                    const current = revision.id === history.headRevisionId
                    const day = dayFormatter.format(revision.createdAt)
                    const previousDay = history.revisions[index - 1]
                      ? dayFormatter.format(history.revisions[index - 1].createdAt)
                      : null
                    const startsDay = day !== previousDay
                    return (
                      <li key={revision.id} className={`min-w-0 ${startsDay ? 'pt-5 first:pt-0' : ''}`}>
                        {startsDay ? (
                          <h2 className="mb-1.5 px-2 font-medium text-[11px] text-slate-500">{day}</h2>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => setSelectedRevisionId(revision.id)}
                          aria-pressed={selected}
                          className={`w-full rounded-lg px-2 py-2 text-left outline-none transition-colors duration-150 ease-out focus-visible:outline focus-visible:outline-2 focus-visible:outline-slate-400 motion-reduce:transition-none ${selected ? 'bg-slate-100' : 'hover:bg-slate-50'}`}
                        >
                          <span className="flex items-baseline justify-between gap-3">
                            <span className="truncate font-medium text-slate-800 text-sm">
                              {actorLabel(revision)}
                              {revision.operation === 'restored' ? ` · ${t('hersteld')}` : ''}
                            </span>
                            <span className="shrink-0 text-slate-600 text-[11px] tabular-nums">
                              {timeFormatter.format(revision.createdAt)}
                            </span>
                          </span>
                          {revision.summary || current ? (
                            <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-slate-600 text-xs leading-4">
                              {revision.summary ? <span className="truncate">{revision.summary}</span> : null}
                              {current ? (
                                <span className="shrink-0 font-medium text-[11px] text-slate-700">
                                  {revision.summary ? '· ' : ''}
                                  {t('Huidig')}
                                </span>
                              ) : null}
                            </span>
                          ) : null}
                        </button>
                      </li>
                    )
                  })}
                </ol>
              </div>

              <div className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)]">
                {selectedRevision ? (
                  <>
                    <div className="flex min-h-14 items-center justify-between gap-4 border-black/[0.06] border-b px-5">
                      <div className="min-w-0">
                        <p className="truncate font-medium text-slate-800 text-sm">
                          {t('Voorbeeld van {date}', { date: dayFormatter.format(selectedRevision.createdAt) })}
                        </p>
                        <p
                          className={`mt-0.5 truncate text-[11px] ${error ? 'text-danger-700' : 'text-slate-500'}`}
                          role={error ? 'alert' : undefined}
                        >
                          {error ??
                            t('{actor} om {time}', {
                              actor: actorName(selectedRevision),
                              time: timeFormatter.format(selectedRevision.createdAt),
                            })}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        color="secondary"
                        onClick={() => setConfirmingRevisionId(selectedRevision.id)}
                        disabled={(!canUndoSelected && selectedRevision.id === history.headRevisionId) || restoring}
                      >
                        {canUndoSelected
                          ? t('Terugdraaien')
                          : selectedRevision.id === history.headRevisionId
                            ? t('Huidige versie')
                            : restoring
                              ? t('Herstellen…')
                              : t('Herstellen')}
                      </Button>
                    </div>
                    <div className="custom-scrollbar min-h-0 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain">
                      <article className="mx-auto w-full max-w-[680px] px-8 py-10 sm:px-12">
                        <h2 className="text-balance font-semibold text-2xl text-slate-950 tracking-tight">
                          {selectedRevision.title}
                        </h2>
                        <WikiEvidence evidence={selectedRevision.evidence} />
                        <MarkdownContent className="mt-8" wikiSpaceId={space.id}>
                          {selectedRevision.content}
                        </MarkdownContent>
                      </article>
                    </div>
                  </>
                ) : null}
              </div>
            </div>
          ) : error ? (
            <div className="m-auto grid justify-items-center gap-3 px-6">
              <p className="text-danger-700 text-sm" role="alert">
                {error}
              </p>
              <Button
                size="small"
                variant="outline"
                color="secondary"
                onClick={() => setLoadAttempt((attempt) => attempt + 1)}
              >
                {t('Opnieuw proberen')}
              </Button>
            </div>
          ) : history ? (
            <p className="m-auto px-6 text-slate-500 text-sm">{t('Nog geen bijdragen.')}</p>
          ) : (
            <div className="m-auto" aria-label={t('Paginageschiedenis laden')}>
              <Spinner size="md" />
            </div>
          )}
        </DialogPanel>
      </div>

      <Dialog
        open={Boolean(confirmingRevision)}
        onClose={restoring ? () => undefined : () => setConfirmingRevisionId(null)}
        className="app-no-drag relative z-50"
      >
        <DialogBackdrop
          transition
          className="fixed inset-0 bg-modal-backdrop backdrop-blur-[1px] transition-opacity duration-150 ease-out data-[closed]:opacity-0 motion-reduce:transition-none"
        />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <DialogPanel
            transition
            className="w-full max-w-sm rounded-xl bg-white p-5 shadow-raised origin-center transition-[opacity,transform] duration-150 ease-out data-[closed]:scale-[0.98] data-[closed]:opacity-0 motion-reduce:transition-none"
          >
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <DialogTitle className="font-semibold text-slate-950 text-md">
                  {undoingLearning ? t('Geleerde kennis terugdraaien?') : t('Deze versie herstellen?')}
                </DialogTitle>
                <DialogDescription className="mt-2 text-slate-600 text-sm leading-5">
                  {undoingLearning
                    ? t(
                        'Remember herstelt de vorige versie, of verwijdert een nieuwe pagina. Deze bron zal dezelfde kennis niet opnieuw toevoegen.'
                      )
                    : t('De huidige pagina blijft in de geschiedenis, zodat je er later naar terug kunt.')}
                </DialogDescription>
              </div>
              <IconButton
                size="compact"
                aria-label={t('Sluiten')}
                onClick={() => setConfirmingRevisionId(null)}
                disabled={restoring}
              >
                <IconCrossSmall className="size-4" aria-hidden="true" />
              </IconButton>
            </div>
            {confirmingRevision ? (
              <p className="mt-4 rounded-lg bg-slate-50 px-3 py-2.5 text-slate-600 text-xs tabular-nums">
                {actorLabel(confirmingRevision)} · {dayFormatter.format(confirmingRevision.createdAt)} ·{' '}
                {timeFormatter.format(confirmingRevision.createdAt)}
              </p>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <Button
                variant="text"
                color="secondary"
                onClick={() => setConfirmingRevisionId(null)}
                disabled={restoring}
              >
                {t('Annuleren')}
              </Button>
              <Button
                variant="solid"
                color="secondary"
                onClick={() => confirmingRevision && void restore(confirmingRevision)}
                disabled={!confirmingRevision || restoring}
              >
                {restoring ? t('Herstellen…') : undoingLearning ? t('Terugdraaien') : t('Versie herstellen')}
              </Button>
            </div>
          </DialogPanel>
        </div>
      </Dialog>
    </Dialog>
  )
}

function RemoveWikiSpaceDialog({
  space,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  space: WikiSpace | null
  busy: boolean
  error: string | null
  onClose: () => void
  onConfirm: () => void
}) {
  const { t } = useI18n()
  return (
    <Dialog open={Boolean(space)} onClose={busy ? () => undefined : onClose} className="app-no-drag relative z-50">
      <DialogBackdrop
        transition
        className="fixed inset-0 bg-modal-backdrop backdrop-blur-[1px] transition-opacity data-[closed]:opacity-0 motion-reduce:transition-none ease-[cubic-bezier(0.215,0.61,0.355,1)] data-[leave]:ease-out duration-(--modal-enter-duration) data-[leave]:duration-(--modal-exit-duration)"
      />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel
          transition
          className="w-full max-w-md origin-center overflow-hidden rounded-xl bg-white shadow-raised transition-[opacity,scale] data-[closed]:scale-[0.98] data-[closed]:opacity-0 motion-reduce:transition-none ease-[cubic-bezier(0.215,0.61,0.355,1)] data-[leave]:ease-out duration-(--modal-enter-duration) data-[leave]:duration-(--modal-exit-duration)"
        >
          <header className="flex items-start justify-between gap-4 border-slate-100 border-b px-4 py-3.5">
            <div className="min-w-0">
              <DialogTitle className="font-semibold text-slate-950 text-md">{t('Space verwijderen')}</DialogTitle>
              <DialogDescription className="mt-0.5 truncate text-slate-500 text-xs">{space?.name}</DialogDescription>
            </div>
            <IconButton aria-label={t('Sluiten')} onClick={onClose} disabled={busy}>
              <IconCrossSmall className="size-4" aria-hidden="true" />
            </IconButton>
          </header>

          <div className="p-4">
            <p className="text-slate-600 text-sm leading-5">
              {t('Deze space en alle pagina’s worden definitief van deze Mac verwijderd.')}
            </p>
            {error ? (
              <p className="mt-3 text-danger-700 text-sm" role="alert">
                {error}
              </p>
            ) : null}
          </div>

          <footer className="flex justify-end gap-2 border-slate-100 border-t px-4 py-3">
            <Button variant="text" color="secondary" onClick={onClose} disabled={busy}>
              {t('Annuleren')}
            </Button>
            <Button color="danger" onClick={onConfirm} disabled={busy}>
              {busy ? t('Verwijderen…') : t('Verwijderen')}
            </Button>
          </footer>
        </DialogPanel>
      </div>
    </Dialog>
  )
}

function DeleteWikiPageDialog({
  page,
  pageCount,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  page: WikiPage | null
  pageCount: number
  busy: boolean
  error: string | null
  onClose: () => void
  onConfirm: () => void
}) {
  const { t } = useI18n()

  return (
    <Dialog open={Boolean(page)} onClose={busy ? () => undefined : onClose} className="app-no-drag relative z-50">
      <DialogBackdrop
        transition
        className="fixed inset-0 bg-modal-backdrop backdrop-blur-[1px] transition-opacity data-[closed]:opacity-0 motion-reduce:transition-none ease-[cubic-bezier(0.215,0.61,0.355,1)] data-[leave]:ease-out duration-(--modal-enter-duration) data-[leave]:duration-(--modal-exit-duration)"
      />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel
          transition
          className="w-full max-w-sm origin-center overflow-hidden rounded-xl bg-white shadow-raised transition-[opacity,scale] data-[closed]:scale-[0.98] data-[closed]:opacity-0 motion-reduce:transition-none ease-[cubic-bezier(0.215,0.61,0.355,1)] data-[leave]:ease-out duration-(--modal-enter-duration) data-[leave]:duration-(--modal-exit-duration)"
        >
          <header className="border-slate-100 border-b px-4 py-3.5">
            <DialogTitle className="font-semibold text-slate-950 text-md">
              {pageCount > 1 ? t('Project verwijderen') : t('Pagina verwijderen')}
            </DialogTitle>
            <DialogDescription className="mt-0.5 truncate text-slate-500 text-xs">{page?.title}</DialogDescription>
          </header>
          <div className="px-4 py-4">
            <p className="text-slate-600 text-sm leading-5">
              {pageCount > 1
                ? t(
                    '{count} pagina’s in dit project worden definitief verwijderd. Dit kan niet ongedaan worden gemaakt.',
                    {
                      count: pageCount,
                    }
                  )
                : t('Deze pagina wordt definitief verwijderd. Dit kan niet ongedaan worden gemaakt.')}
            </p>
            {error ? (
              <p className="mt-3 text-danger-700 text-sm" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <footer className="flex justify-end gap-2 border-slate-100 border-t px-4 py-3">
            <Button variant="text" color="secondary" onClick={onClose} disabled={busy}>
              {t('Annuleren')}
            </Button>
            <Button color="danger" onClick={onConfirm} disabled={busy}>
              {busy ? t('Verwijderen…') : t('Verwijderen')}
            </Button>
          </footer>
        </DialogPanel>
      </div>
    </Dialog>
  )
}

function WikiSpaceDialog({
  open,
  onClose,
  afterLeave,
  onCreate,
}: {
  open: boolean
  onClose: () => void
  afterLeave: () => void
  onCreate: (name: string, description: string) => Promise<void>
}) {
  const { t } = useI18n()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) return
    setName('')
    setDescription('')
    setError(null)
  }, [open])

  async function create() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await onCreate(name.trim(), description.trim())
    } catch {
      setError(t('De space kon niet worden gemaakt.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Transition
      appear
      show={open}
      afterLeave={afterLeave}
      as={Dialog}
      onClose={busy ? () => undefined : onClose}
      className="app-no-drag relative z-50"
    >
      <DialogBackdrop
        transition
        className="fixed inset-0 bg-modal-backdrop backdrop-blur-[1px] transition-opacity data-[closed]:opacity-0 motion-reduce:transition-none ease-[cubic-bezier(0.215,0.61,0.355,1)] data-[leave]:ease-out duration-(--modal-enter-duration) data-[leave]:duration-(--modal-exit-duration)"
      />
      <div className="fixed inset-0 flex items-center justify-center p-4">
        <DialogPanel
          transition
          className="w-full max-w-md origin-center overflow-hidden rounded-xl bg-white shadow-raised transition-[opacity,scale] data-[closed]:scale-[0.98] data-[closed]:opacity-0 motion-reduce:transition-none ease-[cubic-bezier(0.215,0.61,0.355,1)] data-[leave]:ease-out duration-(--modal-enter-duration) data-[leave]:duration-(--modal-exit-duration)"
        >
          <header className="flex items-start justify-between gap-4 border-slate-100 border-b px-4 py-3.5">
            <div className="min-w-0">
              <DialogTitle className="font-semibold text-slate-950 text-md">{t('Nieuwe space')}</DialogTitle>
            </div>
            <IconButton aria-label={t('Sluiten')} onClick={onClose} disabled={busy}>
              <IconCrossSmall className="size-4" aria-hidden="true" />
            </IconButton>
          </header>

          <div className="p-4">
            <form
              onSubmit={(event) => {
                event.preventDefault()
                if (name.trim()) {
                  void create()
                }
              }}
              className="grid gap-3"
            >
              <div className="grid gap-1.5">
                <label htmlFor="wiki-space-name" className="font-medium text-slate-700 text-sm">
                  {t('Naam')}
                </label>
                <input
                  data-autofocus
                  id="wiki-space-name"
                  required
                  value={name}
                  maxLength={80}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={busy}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={t('Werk')}
                  className="h-9 rounded-lg border border-black/[0.08] bg-white px-3 text-slate-900 text-ui outline-none placeholder:text-slate-400 focus:border-slate-300 focus:ring-2 focus:ring-slate-200 disabled:bg-slate-50 disabled:text-slate-400"
                />
              </div>
              <div className="grid gap-1.5">
                <label htmlFor="wiki-space-description" className="font-medium text-slate-700 text-sm">
                  {t('Beschrijving')}
                </label>
                <textarea
                  id="wiki-space-description"
                  value={description}
                  maxLength={280}
                  rows={3}
                  disabled={busy}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder={t('Waar gaat deze Space over?')}
                  className="resize-none rounded-lg border border-black/[0.08] bg-white px-3 py-2 text-slate-900 text-ui leading-5 outline-none placeholder:text-slate-400 focus:border-slate-300 focus:ring-2 focus:ring-slate-200 disabled:bg-slate-50 disabled:text-slate-400"
                />
              </div>
              {error ? (
                <p className="text-danger-700 text-sm" role="alert">
                  {error}
                </p>
              ) : null}
              <div className="flex justify-end border-slate-100 border-t pt-3">
                <Button type="submit" disabled={busy || !name.trim()}>
                  {busy ? t('Maken…') : t('Space maken')}
                </Button>
              </div>
            </form>
          </div>
        </DialogPanel>
      </div>
    </Transition>
  )
}

export function WikiLoadingState() {
  const { t } = useI18n()
  return (
    <div className="mx-auto w-full max-w-[800px] px-6 py-12 sm:px-10">
      <PendingIndicator label={t('Wiki laden')} />
    </div>
  )
}
