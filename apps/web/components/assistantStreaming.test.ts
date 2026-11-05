import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { rehypeStreamingWords } from './assistantStreaming'
import { MarkdownContent } from './MarkdownContent'

function render(enabled: boolean) {
  return renderToStaticMarkup(
    createElement(
      MarkdownContent,
      { rehypePlugins: [[rehypeStreamingWords, { enabled }]] },
      'Hello **autumn forest**.\n\n`const leaf = 1`\n\n```js\nconst tree = 2\n```'
    )
  )
}

test('streaming keeps inline formatting and code intact; historical answers do not animate', () => {
  const html = render(true)
  assert.match(
    html,
    /<strong><span class="assistant-stream-word">autumn <\/span><span class="assistant-stream-word">forest<\/span><\/strong>/
  )
  assert.match(html, /<code>const leaf = 1<\/code>/)
  assert.match(html, /<code class="language-js">const tree = 2\n<\/code>/)
  assert.doesNotMatch(render(false), /assistant-stream-word/)
})
