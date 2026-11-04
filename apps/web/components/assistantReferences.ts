import { wikiPageHref } from './wikiRoutes'

export type AssistantReference =
  | { kind: 'task'; id: string; href: string }
  | { kind: 'day' | 'note'; id: string; href: string }
  | { kind: 'document'; spaceId: string; slug: string; href: string }

export function assistantReference(href?: string): AssistantReference | null {
  if (!href?.startsWith('/') || href.startsWith('//') || href.includes('\\')) return null
  try {
    const url = new URL(href, 'https://remember.invalid')
    if (url.origin !== 'https://remember.invalid') return null
    if (url.pathname === '/inbox/' && url.searchParams.getAll('item').length === 1) {
      const id = url.searchParams.get('item')
      return id ? { kind: 'task', id, href: `/inbox/?item=${encodeURIComponent(id)}` } : null
    }
    if (
      url.pathname === '/wiki/page/' &&
      url.searchParams.getAll('slug').length === 1 &&
      url.searchParams.getAll('space').length === 1
    ) {
      const spaceId = url.searchParams.get('space')
      const slug = url.searchParams.get('slug')
      return spaceId && slug ? { kind: 'document', spaceId, slug, href: wikiPageHref(spaceId, slug) } : null
    }
  } catch {}
  return null
}

type MarkdownNode = {
  type: string
  url?: string
  identifier?: string
  children?: MarkdownNode[]
}

/** Keep prose intact and collect explicit Remember links into one deduplicated attachment list. */
export function remarkAssistantReferences(options: { exclude?: string[] } = {}) {
  return (tree: MarkdownNode) => {
    const references = new Map<string, MarkdownNode>()
    const definitions = new Map<string, string>()
    for (const child of tree.children ?? []) {
      if (child.type === 'definition' && child.identifier && child.url)
        definitions.set(child.identifier.toLowerCase(), child.url)
    }
    function collect(node: MarkdownNode) {
      if (!node.children || node.type === 'code' || node.type === 'inlineCode') return
      node.children = node.children.flatMap((child) => {
        const href =
          child.type === 'link'
            ? child.url
            : child.type === 'linkReference'
              ? definitions.get(child.identifier?.toLowerCase() ?? '')
              : undefined
        const reference = assistantReference(href)
        if (reference) {
          if (!references.has(reference.href))
            references.set(reference.href, { type: 'link', url: reference.href, children: child.children })
          return child.children ?? []
        }
        collect(child)
        return [child]
      })
    }
    collect(tree)
    const links = [...references].filter(([href]) => !options.exclude?.includes(href)).map(([, link]) => link)
    if (links.length) tree.children?.push({ type: 'paragraph', children: links })
  }
}
