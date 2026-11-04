import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { isLocalImageSource, MarkdownContent } from './MarkdownContent'

function renderImage(source: string) {
  return renderToStaticMarkup(createElement(MarkdownContent, null, `![Diagram](${source})`))
}

describe('Markdown content', () => {
  it('renders internal source links and external references without leaking Markdown nodes', () => {
    const content = renderToStaticMarkup(
      createElement(
        MarkdownContent,
        null,
        '[Project context](/wiki/page/?space=demo-northstar&slug=decisions%2Fproject-context)\n\n[Reference](https://example.test/research)'
      )
    )
    assert.match(content, /href="\/wiki\/page\/?\?space=demo-northstar&amp;slug=decisions%2Fproject-context"/)
    assert.match(content, /href="https:\/\/example.test\/research"/)
    assert.doesNotMatch(content, / node=/)
  })

  it('renders comparison tables with column headers and inline formatting', () => {
    const table = renderToStaticMarkup(
      createElement(
        MarkdownContent,
        null,
        '| Optie | Prijs |\n| --- | ---: |\n| **Cedar Lodge** | $600 |\n| Miners Inn | $300 |'
      )
    )

    assert.match(table, /<table\b/)
    assert.match(table, /<th scope="col">Optie<\/th>/)
    assert.match(table, /<th style="text-align:right" scope="col">Prijs<\/th>/)
    assert.match(table, /<td><strong>Cedar Lodge<\/strong><\/td>/)
    assert.match(table, /<td style="text-align:right">\$600<\/td>/)
    assert.doesNotMatch(table, /\| ---| node=/)
  })

  it('keeps remote images inert while rendering local images', () => {
    const remoteSources = [
      'https://example.test/pixel.png',
      '//example.test/pixel.png',
      ' //example.test/pixel.png',
      '\t//example.test/pixel.png',
      '\\\\example.test/pixel.png',
    ]
    for (const source of remoteSources) assert.equal(isLocalImageSource(source), false)

    for (const source of remoteSources.slice(0, -1)) {
      const remote = renderImage(source)
      assert.doesNotMatch(remote, /example\.test|<img|preload/)
      assert.match(remote, /Diagram/)
    }

    assert.equal(isLocalImageSource('/images/diagram.png'), true)
    assert.equal(isLocalImageSource('http://127.0.0.1:3210/diagram.png'), true)
    const local = renderImage('/images/diagram.png')
    assert.match(local, /<img[^>]+src="\/images\/diagram\.png"/)
    assert.doesNotMatch(local, / node=/)
    assert.match(renderImage('http://127.0.0.1:3210/diagram.png'), /<img[^>]+src="http:\/\/127\.0\.0\.1/)
  })
})
