import Link from '@tiptap/extension-link'
import type { Attributes } from '@tiptap/react'
import { wikiMarkdownHref } from './wikiRoutes'

export function createWikiLink(spaceId: string) {
  return Link.extend({
    addAttributes() {
      const attributes: Attributes = this.parent?.() ?? {}
      return {
        ...attributes,
        href: {
          ...attributes?.href,
          renderHTML: ({ href }) => ({ href: typeof href === 'string' ? wikiMarkdownHref(spaceId, href) : href }),
        },
      }
    },
  }).configure({
    autolink: true,
    linkOnPaste: true,
    openOnClick: false,
    HTMLAttributes: { tabindex: '0' },
  })
}
