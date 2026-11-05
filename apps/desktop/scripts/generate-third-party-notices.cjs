const { createHash } = require('node:crypto')
const { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } = require('node:fs')
const { createRequire } = require('node:module')
const path = require('node:path')

function packageDirectory(name, from) {
  const requireFrom = createRequire(path.join(from, 'package.json'))
  for (const directory of requireFrom.resolve.paths(name) ?? []) {
    const candidate = path.join(directory, name)
    if (existsSync(path.join(candidate, 'package.json'))) return realpathSync(candidate)
  }
  throw new Error(`license-package-unresolved:${name}`)
}

function generateNotices(repository) {
  const packages = new Map()
  const texts = new Map()
  const visited = new Set()
  function visit(directory) {
    const metadata = JSON.parse(readFileSync(path.join(directory, 'package.json'), 'utf8'))
    const id = `${metadata.name}@${metadata.version}`
    if (visited.has(id)) return
    visited.add(id)
    if (!metadata.name.startsWith('@remember/') && metadata.name !== 'remember') {
      const notices = []
      for (const name of readdirSync(directory).sort()) {
        const file = path.join(directory, name)
        if (!/^(?:licen[cs]e|copying|notice|copyright)(?:[.-].*)?$/i.test(name) || !statSync(file).isFile()) continue
        const text = readFileSync(file, 'utf8')
          .replace(/\r\n/g, '\n')
          .replace(/[\t ]+$/gm, '')
          .trim()
        if (!text) continue
        const hash = createHash('sha256').update(text).digest('hex')
        if (!texts.has(hash)) texts.set(hash, { text, packages: [] })
        texts.get(hash).packages.push(`${id} (${name})`)
        notices.push(hash)
      }
      packages.set(id, {
        license: typeof metadata.license === 'string' ? metadata.license : 'See upstream package terms',
        repository: typeof metadata.repository === 'string' ? metadata.repository : metadata.repository?.url,
        notices,
      })
    }
    for (const name of Object.keys(metadata.dependencies ?? {}).sort()) visit(packageDirectory(name, directory))
    for (const name of Object.keys(metadata.optionalDependencies ?? {}).sort()) {
      let optional
      try {
        optional = packageDirectory(name, directory)
      } catch {
        continue
      }
      visit(optional)
    }
  }
  visit(path.join(repository, 'apps', 'desktop'))
  visit(path.join(repository, 'apps', 'web'))
  const lines = [
    '# Third-party notices',
    '',
    'Remember includes third-party software. Each component remains subject to its own license and copyright notices; this inventory grants no additional rights.',
    'The inventory includes the installed production dependency closure of the desktop and renderer, plus adapted Lucide Animated icons and the website fonts. Some listed components are build-time parts of those packages rather than distributed code.',
    'Electron and Chromium notices are included separately beside this file. The bundled Claude runtime is subject to Anthropic’s applicable agreements, reproduced in claude-agent-sdk.txt; the OpenAI Codex Apache license is in codex-APACHE-2.0.txt.',
    '',
    '## Components',
    '',
  ]
  const textIds = new Map([...texts.keys()].map((hash, index) => [hash, index + 1]))
  for (const [id, item] of [...packages.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`- **${id}** — ${item.license}`)
    if (item.repository) lines.push(`  Source: ${item.repository}`)
    if (item.notices.length)
      lines.push(`  Included notices: ${item.notices.map((hash) => textIds.get(hash)).join(', ')}`)
  }
  lines.push(
    '',
    '## Lucide Animated icons',
    '',
    'Source: https://github.com/pqoqubbw/icons',
    '',
    'Static icon geometry adapted for Remember.',
    '',
    '````text',
    readFileSync(path.join(repository, 'apps/web/ui/lucide-animated-LICENSE.txt'), 'utf8').trimEnd(),
    '````',
    ''
  )
  lines.push('', '## Website fonts', '')
  for (const name of ['Figtree', 'Manrope']) {
    const family = name.toLowerCase()
    const licensePath = `apps/site/public/fonts/${family}-OFL.txt`
    lines.push(
      `### ${name}`,
      '',
      `Source: https://github.com/google/fonts/tree/main/ofl/${family}`,
      `License: SIL Open Font License 1.1; [bundled license](${licensePath}).`,
      '',
      '````text',
      readFileSync(path.join(repository, licensePath), 'utf8')
        .replace(/[\t ]+$/gm, '')
        .trimEnd(),
      '````',
      ''
    )
  }
  lines.push('', '## License and notice texts', '')
  for (const [hash, notice] of texts) {
    lines.push(
      `### Notice ${textIds.get(hash)}`,
      '',
      notice.packages.sort().join('; '),
      '',
      '````text',
      notice.text,
      '````',
      ''
    )
  }
  const file = path.join(repository, 'THIRD_PARTY_NOTICES.md')
  writeFileSync(file, `${lines.join('\n').trimEnd()}\n`)
  return { file, packages: packages.size, notices: texts.size }
}

module.exports = { generateNotices }
if (require.main === module) console.log(generateNotices(path.resolve(__dirname, '../../..')))
