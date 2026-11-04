'use client'

import { useLocalBridge } from '@internal/context/LocalBridgeProvider'
import { readLocalStorageJson, removeLocalStorageItem, writeLocalStorageJson } from '@internal/lib/localStorageJson'
import { useI18n } from '@internal/locales'
import { Button } from '@internal/ui/Button'
import type { SaveWikiPageInput, WikiPage } from '@remember/shared'
import Placeholder from '@tiptap/extension-placeholder'
import { TableKit } from '@tiptap/extension-table'
import { Markdown } from '@tiptap/markdown'
import { EditorContent, useEditor } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import { FileText as IconFileText } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { preserveManualMeetingSource } from './conversationSpaceContext'
import { markdownContentClassName, markdownTableClassName } from './MarkdownContent'
import { wikiDraftStorageKey } from './wikiDrafts'
import { createWikiLink } from './wikiLink'
import { normalizeWikiEditorMarkdown } from './wikiMarkdown'
import { wikiPageHref } from './wikiRoutes'

type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'conflict' | 'error'
type StoredWikiDraft = {
  version: 2
  baseSignature: string
  expectedRevision: string | null
  title: string
  content: string
}

type UnvalidatedWikiDraft = Partial<Record<keyof StoredWikiDraft, unknown>>

function readStoredWikiDraft(key: string): StoredWikiDraft | null {
  const stored = readLocalStorageJson(key) as UnvalidatedWikiDraft | null
  if (!stored) return null
  if (
    (stored.version !== 1 && stored.version !== 2) ||
    typeof stored.baseSignature !== 'string' ||
    typeof stored.title !== 'string' ||
    typeof stored.content !== 'string' ||
    (stored.version === 2 && stored.expectedRevision !== null && typeof stored.expectedRevision !== 'string')
  ) {
    removeLocalStorageItem(key)
    return null
  }
  return {
    version: 2,
    baseSignature: stored.baseSignature,
    expectedRevision:
      stored.version === 2 && typeof stored.expectedRevision === 'string' ? stored.expectedRevision : null,
    title: stored.title,
    content: stored.content,
  }
}

export function WikiEditor({
  spaceId,
  page,
  onSave,
  onReload,
  onRegisterFlush,
  subpages,
  creationError,
  startWithBlankTitle = false,
}: {
  spaceId: string
  page: WikiPage
  onSave: (input: SaveWikiPageInput) => Promise<WikiPage[]>
  onReload: () => Promise<void>
  onRegisterFlush?: (flush: (() => Promise<void>) | null) => void
  subpages: WikiPage[]
  creationError: string | null
  startWithBlankTitle?: boolean
}) {
  const { t } = useI18n()
  const { registerWikiEditorFlush, canAccessWikiSpace } = useLocalBridge()
  const router = useRouter()
  const draftStorageKey = useRef(wikiDraftStorageKey(spaceId, page.slug)).current
  const initialTitle = startWithBlankTitle ? '' : page.title
  const [title, setTitle] = useState(initialTitle)
  const [content, setContent] = useState(page.content)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle')
  const [resolvingConflict, setResolvingConflict] = useState(false)
  const [conflictError, setConflictError] = useState<string | null>(null)
  const titleRef = useRef(initialTitle)
  const contentRef = useRef(page.content)
  const titleInputRef = useRef<HTMLTextAreaElement>(null)
  const editorRef = useRef<ReturnType<typeof useEditor>>(null)
  const initialPageRef = useRef(page)
  const lastSavedRef = useRef(`${page.title}\u0000${page.content}`)
  const draftBaseSignatureRef = useRef(lastSavedRef.current)
  const expectedRevisionRef = useRef(page.revision)
  const draftConflictRef = useRef(false)
  const saveRequestedRef = useRef(false)
  const saveLoopRef = useRef<Promise<void> | null>(null)
  const isMountedRef = useRef(true)

  const storeDraft = useCallback(
    (draft: Omit<StoredWikiDraft, 'version'>) => {
      if (!canAccessWikiSpace(spaceId)) return
      writeLocalStorageJson(draftStorageKey, { version: 2, ...draft } satisfies StoredWikiDraft)
    },
    [canAccessWikiSpace, draftStorageKey, spaceId]
  )

  const saveDraft = useCallback(() => {
    if (!canAccessWikiSpace(spaceId)) return Promise.resolve()
    if (draftConflictRef.current) return Promise.resolve()
    saveRequestedRef.current = true
    if (saveLoopRef.current) return saveLoopRef.current

    const loop = (async () => {
      while (saveRequestedRef.current) {
        saveRequestedRef.current = false
        if (!canAccessWikiSpace(spaceId)) break
        const nextTitle = titleRef.current.trim()
        const nextContent = contentRef.current
        const signature = `${nextTitle}\u0000${nextContent}`
        if (!nextTitle) continue
        if (signature === lastSavedRef.current) {
          removeLocalStorageItem(draftStorageKey)
          continue
        }
        const requestExpectedRevision = expectedRevisionRef.current

        if (isMountedRef.current) setSaveStatus('saving')
        try {
          const pages = await onSave({
            spaceId,
            slug: page.slug,
            title: nextTitle,
            content: nextContent,
            expectedRevision: requestExpectedRevision,
          })
          const savedPage = pages.find((candidate) => candidate.slug === page.slug)
          if (!savedPage?.revision) throw new Error('wiki-save-failed')
          const savedSignature = `${savedPage.title}\u0000${savedPage.content}`
          const currentSignature = `${titleRef.current.trim()}\u0000${contentRef.current}`
          const remainedClean = currentSignature === signature
          if (remainedClean) {
            expectedRevisionRef.current = savedPage.revision
            lastSavedRef.current = savedSignature
            draftBaseSignatureRef.current = savedSignature
            titleRef.current = savedPage.title
            contentRef.current = savedPage.content
            if (isMountedRef.current) {
              setTitle(savedPage.title)
              setContent(savedPage.content)
              if (savedSignature !== signature) {
                editorRef.current?.commands.setContent(normalizeWikiEditorMarkdown(savedPage.content), {
                  contentType: 'markdown',
                  emitUpdate: false,
                })
              }
            }
            removeLocalStorageItem(draftStorageKey)
          } else {
            expectedRevisionRef.current = requestExpectedRevision
            storeDraft({
              baseSignature: draftBaseSignatureRef.current,
              expectedRevision: requestExpectedRevision ?? null,
              title: titleRef.current,
              content: contentRef.current,
            })
          }
          if (isMountedRef.current) setSaveStatus(remainedClean ? 'saved' : 'dirty')
        } catch (error) {
          saveRequestedRef.current = false
          if (isMountedRef.current) {
            setSaveStatus(String(error).includes('wiki-page-conflict') ? 'conflict' : 'error')
          }
        }
      }
    })().finally(() => {
      saveLoopRef.current = null
    })
    saveLoopRef.current = loop
    return loop
  }, [canAccessWikiSpace, draftStorageKey, onSave, page.slug, spaceId, storeDraft])

  const flushDraft = useCallback(async () => {
    await saveDraft()
    const signature = `${titleRef.current.trim()}\u0000${contentRef.current}`
    if (signature !== lastSavedRef.current) throw new Error('wiki-save-failed')
  }, [saveDraft])

  useEffect(() => {
    const persistDraftBeforeUnload = () => {
      const signature = `${titleRef.current.trim()}\u0000${contentRef.current}`
      if (signature === lastSavedRef.current) return
      storeDraft({
        baseSignature: draftBaseSignatureRef.current,
        expectedRevision: expectedRevisionRef.current ?? null,
        title: titleRef.current,
        content: contentRef.current,
      })
    }
    window.addEventListener('beforeunload', persistDraftBeforeUnload)
    return () => window.removeEventListener('beforeunload', persistDraftBeforeUnload)
  }, [storeDraft])

  async function preserveDraftAndReload() {
    if (resolvingConflict) return
    setResolvingConflict(true)
    setConflictError(null)
    try {
      const heading = titleRef.current.trim() ? `# ${titleRef.current.trim()}\n\n` : ''
      await navigator.clipboard.writeText(`${heading}${contentRef.current}`.trim())
      await onReload()
      draftConflictRef.current = false
      lastSavedRef.current = `${titleRef.current.trim()}\u0000${contentRef.current}`
      removeLocalStorageItem(draftStorageKey)
    } catch {
      setConflictError(t('Het concept kon niet worden gekopieerd. De nieuwste versie is niet geladen.'))
      setResolvingConflict(false)
    }
  }

  function openInternalLink(target: EventTarget | null, newTab = false) {
    const link = target instanceof Element ? target.closest('a') : null
    const href = link?.getAttribute('href')
    if (!href || !/^\/(?:wiki|conversations)\//.test(href)) return false

    if (newTab) {
      window.open(href, '_blank', 'noopener,noreferrer')
      return true
    }

    void flushDraft()
      .then(() => router.push(href))
      .catch(() => setConflictError(t('De laatste wijzigingen konden niet worden opgeslagen.')))
    return true
  }

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ link: false }),
      TableKit.configure({
        table: { renderWrapper: true, HTMLAttributes: { class: markdownTableClassName } },
        tableHeader: { HTMLAttributes: { scope: 'col' } },
      }),
      createWikiLink(spaceId),
      Markdown.configure({
        indentation: { style: 'space', size: 2 },
        markedOptions: { gfm: true, breaks: false },
      }),
      Placeholder.configure({ placeholder: t('Begin met schrijven…') }),
    ],
    content: normalizeWikiEditorMarkdown(page.content),
    contentType: 'markdown',
    immediatelyRender: false,
    editorProps: {
      attributes: {
        'aria-label': t('Pagina-inhoud'),
        'aria-multiline': 'true',
        role: 'textbox',
        spellcheck: 'true',
        class: `wiki-markdown-editor ${markdownContentClassName} flex-1 caret-blue-700 outline-none [&_.tableWrapper]:my-4 [&_.tableWrapper]:max-w-full [&_.tableWrapper]:overflow-x-auto`,
      },
      handleDOMEvents: {
        keydown: (_view, event) => {
          if (event.key !== 'Enter' || !openInternalLink(event.target, event.metaKey || event.ctrlKey)) return false
          event.preventDefault()
          return true
        },
        auxclick: (_view, event) => {
          if (event.button !== 1 || !openInternalLink(event.target, true)) return false
          event.preventDefault()
          return true
        },
      },
      handleKeyDown: (_view, event) => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 's') {
          event.preventDefault()
          void saveDraft()
          return true
        }
        return false
      },
      handleClick: (_view, _position, event) => {
        if (event.button !== 0 || !openInternalLink(event.target, event.metaKey || event.ctrlKey || event.shiftKey))
          return false
        event.preventDefault()
        return true
      },
    },
    onUpdate: ({ editor: activeEditor }) => updateContent(normalizeWikiEditorMarkdown(activeEditor.getMarkdown())),
  })
  editorRef.current = editor

  useEffect(() => {
    if (!editor || !canAccessWikiSpace(spaceId)) return
    const stored = readStoredWikiDraft(draftStorageKey)
    if (stored) {
      if (`${stored.title.trim()}\u0000${stored.content}` !== lastSavedRef.current) {
        preserveManualMeetingSource(spaceId, initialPageRef.current.slug)
      }
      titleRef.current = stored.title
      contentRef.current = stored.content
      draftBaseSignatureRef.current = stored.baseSignature
      if (stored.expectedRevision) expectedRevisionRef.current = stored.expectedRevision
      draftConflictRef.current = stored.expectedRevision === null && stored.baseSignature !== lastSavedRef.current
      setTitle(stored.title)
      setContent(stored.content)
      setSaveStatus(draftConflictRef.current ? 'conflict' : 'dirty')
      editor.commands.setContent(normalizeWikiEditorMarkdown(stored.content), {
        contentType: 'markdown',
        emitUpdate: false,
      })
    }
  }, [canAccessWikiSpace, draftStorageKey, editor, spaceId])

  useEffect(() => {
    if (!editor || page.revision === expectedRevisionRef.current) return
    const currentSignature = `${titleRef.current.trim()}\u0000${contentRef.current}`
    if (currentSignature !== lastSavedRef.current) return
    const nextSignature = `${page.title}\u0000${page.content}`
    titleRef.current = page.title
    contentRef.current = page.content
    lastSavedRef.current = nextSignature
    draftBaseSignatureRef.current = nextSignature
    expectedRevisionRef.current = page.revision
    setTitle(page.title)
    setContent(page.content)
    editor.commands.setContent(normalizeWikiEditorMarkdown(page.content), {
      contentType: 'markdown',
      emitUpdate: false,
    })
  }, [editor, page.content, page.revision, page.title])

  useEffect(() => {
    if (startWithBlankTitle && !('ontouchstart' in window)) titleInputRef.current?.focus()
  }, [startWithBlankTitle])

  useEffect(() => {
    onRegisterFlush?.(flushDraft)
    return () => onRegisterFlush?.(null)
  }, [flushDraft, onRegisterFlush])

  useEffect(() => {
    return registerWikiEditorFlush(spaceId, flushDraft)
  }, [flushDraft, registerWikiEditorFlush, spaceId])

  useEffect(() => {
    if (saveStatus !== 'dirty') return
    const pendingSignature = `${title.trim()}\u0000${content}`
    const timer = window.setTimeout(() => {
      if (pendingSignature === `${titleRef.current.trim()}\u0000${contentRef.current}`) void saveDraft()
    }, 300)
    return () => window.clearTimeout(timer)
  }, [content, saveDraft, saveStatus, title])

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      const signature = `${titleRef.current.trim()}\u0000${contentRef.current}`
      if (signature === lastSavedRef.current) return
      storeDraft({
        baseSignature: draftBaseSignatureRef.current,
        expectedRevision: expectedRevisionRef.current ?? null,
        title: titleRef.current,
        content: contentRef.current,
      })
      void saveDraft()
    }
  }, [saveDraft, storeDraft])

  function updateTitle(value: string) {
    if (value !== titleRef.current) preserveManualMeetingSource(spaceId, page.slug)
    titleRef.current = value
    persistCurrentDraft()
    setTitle(value)
    setSaveStatus(draftConflictRef.current ? 'conflict' : 'dirty')
  }

  function updateContent(value: string) {
    if (value !== contentRef.current) preserveManualMeetingSource(spaceId, page.slug)
    contentRef.current = value
    persistCurrentDraft()
    setContent(value)
    setSaveStatus(draftConflictRef.current ? 'conflict' : 'dirty')
  }

  function persistCurrentDraft() {
    if (`${titleRef.current.trim()}\u0000${contentRef.current}` === lastSavedRef.current) {
      removeLocalStorageItem(draftStorageKey)
      return
    }
    storeDraft({
      baseSignature: draftBaseSignatureRef.current,
      expectedRevision: expectedRevisionRef.current ?? null,
      title: titleRef.current,
      content: contentRef.current,
    })
  }

  return (
    <article className="mx-auto flex min-h-full w-full max-w-[800px] flex-col px-6 py-10 sm:px-10 md:py-12">
      <header className="flex items-start gap-4">
        <label htmlFor="wiki-page-title" className="sr-only">
          {t('Paginatitel')}
        </label>
        <h1 className="min-w-0 flex-1">
          <textarea
            id="wiki-page-title"
            ref={titleInputRef}
            rows={1}
            maxLength={120}
            value={title}
            onChange={(event) => updateTitle(event.target.value.replace(/[\r\n]/g, ''))}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                editor?.commands.focus('start')
              }
              if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 's') {
                event.preventDefault()
                void saveDraft()
              }
            }}
            spellCheck="true"
            className="w-full resize-none overflow-hidden bg-transparent font-display font-semibold text-2xl text-slate-950 leading-[1.15] tracking-[-0.025em] outline-none placeholder:text-slate-300 [field-sizing:content] focus-visible:ring-0"
            placeholder={t('Naamloze pagina')}
          />
        </h1>
        <div className="flex min-h-5 shrink-0 items-center justify-end pt-1 text-right text-xs" aria-live="polite">
          {saveStatus === 'dirty' && !title.trim() ? (
            <span className="text-danger-700">{t('Voeg een titel toe')}</span>
          ) : null}
          {saveStatus === 'conflict' ? (
            <span className="text-amber-700">{t('Nieuwere versie beschikbaar')}</span>
          ) : null}
          {saveStatus === 'error' ? <span className="text-danger-700">{t('Opslaan mislukt')}</span> : null}
        </div>
      </header>

      {saveStatus === 'conflict' ? (
        <div className="mt-5 flex flex-col gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p className="font-medium text-amber-950">{t('Iemand anders heeft deze pagina gewijzigd.')}</p>
            <p className="mt-0.5 text-amber-800">
              {t('Je concept blijft hier staan. Kopieer het voordat Remember de nieuwste versie laadt.')}
            </p>
          </div>
          <Button
            variant="outline"
            color="secondary"
            className="self-start sm:self-auto"
            disabled={resolvingConflict}
            onClick={() => void preserveDraftAndReload()}
          >
            {resolvingConflict ? t('Nieuwste versie laden…') : t('Concept kopiëren en nieuwste laden')}
          </Button>
        </div>
      ) : null}

      {conflictError ? (
        <p className="mt-3 text-danger-700 text-sm" role="alert">
          {conflictError}
        </p>
      ) : null}

      {subpages.length ? (
        <section aria-label={t('Subpagina’s')} className="mt-6">
          <ul className="grid gap-0.5">
            {subpages.map((subpage) => (
              <li key={subpage.slug}>
                <Link
                  href={wikiPageHref(spaceId, subpage.slug)}
                  className="-mx-3 flex min-h-10 min-w-0 items-center pointer-coarse:min-h-11 gap-2 rounded-lg px-3 py-2 font-medium text-slate-900 text-ui outline-none transition-colors duration-150 ease-out hover:bg-slate-100/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-slate-400 motion-reduce:transition-none"
                >
                  <IconFileText className="size-4 shrink-0 text-slate-400" aria-hidden="true" />
                  <span className="truncate">{subpage.title}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {creationError ? (
        <p className="mt-4 text-danger-700 text-sm" role="alert">
          {creationError}
        </p>
      ) : null}

      <EditorContent
        editor={editor}
        className={`${subpages.length ? 'mt-6' : 'mt-4'} flex min-h-[28rem] w-full flex-1 flex-col [&_.ProseMirror>*:first-child]:mt-0 [&_.ProseMirror]:flex-1`}
      />
    </article>
  )
}
