import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { MarkdownManager } from '@tiptap/markdown'
import StarterKit from '@tiptap/starter-kit'
import { normalizeWikiEditorMarkdown } from './wikiMarkdown'

const markdown = new MarkdownManager({ extensions: [StarterKit] })

describe('Wiki Markdown', () => {
  it('preserves supported Markdown through the rich editor document model', () => {
    const source = [
      '## Project decision',
      '',
      'The Wiki keeps **important context** and *supporting detail*.',
      '',
      '- First result',
      '- Second result',
      '',
      '> Shared with the team.',
      '',
      '```ts',
      'const synced = true',
      '```',
    ].join('\n')

    assert.equal(markdown.serialize(markdown.parse(source)), source)
  })

  it('removes Remember metadata before the editor parses the first content block', () => {
    const expected = '## Current state\n\nCapture is healthy.'
    const source = [
      '',
      '<!-- remember-managed:start -->',
      '## Current state',
      '',
      'Capture is healthy.',
      '<!-- remember-managed:end -->',
      '',
      '<!-- remember-source:daily-review://day-1 -->',
      '',
    ].join('\n')
    const editorContent = normalizeWikiEditorMarkdown(source)

    assert.equal(editorContent, expected)
    assert.equal(markdown.parse(editorContent).content?.[0]?.type, 'heading')
    assert.equal(normalizeWikiEditorMarkdown(`&lt;!-- remember-managed:start --&gt;\n\n${expected}`), expected)

    const spacing = ['First line  ', 'Second line', '', '```text', '', '', '```'].join('\n')
    assert.equal(normalizeWikiEditorMarkdown(spacing), spacing)
  })
})
