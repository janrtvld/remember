import Link from 'next/link'
import { type ComponentProps, memo } from 'react'
import type { ExtraProps } from 'react-markdown'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { twMerge } from 'tailwind-merge'
import { wikiMarkdownHref } from './wikiRoutes'

export const markdownContentClassName =
  'prose prose-slate max-w-none font-sans text-slate-800 text-ui leading-6 prose-headings:font-semibold prose-headings:tracking-tight prose-headings:text-slate-950 prose-h1:text-xl prose-h2:text-lg prose-h3:text-md prose-headings:mt-8 prose-headings:mb-4 prose-p:my-0 prose-p:text-slate-800 prose-ul:my-0 prose-ul:pl-6 prose-ol:my-0 prose-ol:pl-6 prose-li:my-0 prose-li:text-slate-800 prose-li:marker:text-slate-500 [&_p+p]:mt-4 [&_li+li]:mt-1.5 prose-table:my-0 prose-blockquote:border-slate-300 prose-blockquote:text-slate-600 prose-code:rounded prose-code:bg-slate-100 prose-code:px-1 prose-code:py-0.5 prose-code:font-medium prose-code:text-slate-800 prose-code:before:content-none prose-code:after:content-none prose-pre:bg-slate-900 prose-pre:text-slate-100'

export const compactMarkdownContentClassName =
  'leading-[22px] prose-headings:mt-5 prose-headings:mb-2 [&_p+p]:mt-3 [&_li+li]:mt-1 [&_table_th]:py-2 [&_table_td]:py-2'

export const markdownTableClassName =
  'my-0 w-full text-sm leading-5 [&_th]:min-w-36 [&_th]:border-slate-200 [&_th]:border-b [&_th]:px-3 [&_th]:py-2.5 [&_th]:align-top [&_th]:font-medium [&_th]:text-inherit [&_td]:border-slate-100 [&_td]:border-b [&_td]:px-3 [&_td]:py-2.5 [&_td]:align-top [&_tr:last-child_td]:border-b-0'

export function isLocalImageSource(source: string) {
  const normalized = source.trim()
  if (/^data:image\/(?:avif|gif|jpe?g|png|webp);base64,/i.test(normalized) || normalized.startsWith('blob:')) {
    return true
  }
  try {
    const url = new URL(normalized, 'http://localhost/')
    return url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
  } catch {
    return false
  }
}

function MarkdownImage({ src, alt, node: _node, ...props }: ComponentProps<'img'> & ExtraProps) {
  if (typeof src !== 'string' || !isLocalImageSource(src)) return alt ? <span>{alt}</span> : null
  // biome-ignore lint/performance/noImgElement: Markdown images have dynamic local sources and unknown dimensions.
  return <img {...props} src={src} alt={alt ?? ''} />
}

function MarkdownLink({
  href,
  wikiSpaceId,
  node: _node,
  ...props
}: ComponentProps<'a'> & ExtraProps & { wikiSpaceId?: string }) {
  const destination = href && wikiSpaceId ? wikiMarkdownHref(wikiSpaceId, href) : href
  if (destination?.startsWith('/') && !destination.startsWith('//')) {
    return <Link {...props} href={destination} />
  }
  return <a {...props} href={destination} />
}

function MarkdownTable({ className, node: _node, ...props }: ComponentProps<'table'> & ExtraProps) {
  return (
    <div
      role="group"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: Overflowing tables need a keyboard scrolling target.
      tabIndex={0}
      className="my-4 max-w-full overflow-x-auto rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-slate-400"
    >
      <table {...props} className={twMerge(markdownTableClassName, className)} />
    </div>
  )
}

function MarkdownTableHeader({ node: _node, ...props }: ComponentProps<'th'> & ExtraProps) {
  return <th {...props} scope="col" />
}

export function MarkdownContent({
  className,
  components,
  remarkPlugins,
  wikiSpaceId,
  ...props
}: ComponentProps<typeof ReactMarkdown> & { className?: string; wikiSpaceId?: string }) {
  return (
    <div className={twMerge(markdownContentClassName, className)}>
      <ReactMarkdown
        {...props}
        remarkPlugins={[remarkGfm, ...(remarkPlugins ?? [])]}
        components={{
          a: (linkProps) => <MarkdownLink {...linkProps} wikiSpaceId={wikiSpaceId} />,
          table: MarkdownTable,
          th: MarkdownTableHeader,
          ...components,
          img: MarkdownImage,
        }}
      />
    </div>
  )
}

/** Inline formatting for compact previews inside an existing navigation link. */
export const MarkdownPreview = memo(function MarkdownPreview({
  children,
  className,
}: {
  children: string
  className?: string
}) {
  return (
    <span className={className}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        allowedElements={['strong', 'em', 'del', 'code']}
        unwrapDisallowed
        skipHtml
      >
        {children}
      </ReactMarkdown>
    </span>
  )
})

export function MarkdownList({ items, className }: { items: string[]; className?: string }) {
  return (
    <div className={twMerge(markdownContentClassName, className)}>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  )
}
