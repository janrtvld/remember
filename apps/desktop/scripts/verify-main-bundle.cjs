const { builtinModules } = require('node:module')
const { readdir, readFile } = require('node:fs/promises')
const path = require('node:path')
const { parseAst } = require('vite')

const allowedRuntimeImports = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`), 'electron'])

async function listJavaScriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(
    entries.map((entry) => {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) return listJavaScriptFiles(entryPath)
      return entry.isFile() && /\.[cm]?js$/.test(entry.name) ? [entryPath] : []
    })
  )
  return files.flat()
}

function runtimeSpecifiers(source) {
  const imports = []
  const requires = []
  const nodes = [parseAst(source)]
  while (nodes.length > 0) {
    const node = nodes.pop()
    if (
      ['ImportDeclaration', 'ExportAllDeclaration', 'ExportNamedDeclaration', 'ImportExpression'].includes(node.type) &&
      typeof node.source?.value === 'string'
    )
      imports.push(node.source.value)
    if (
      node.type === 'CallExpression' &&
      node.callee.type === 'Identifier' &&
      node.callee.name === 'require' &&
      typeof node.arguments[0]?.value === 'string'
    )
      requires.push(node.arguments[0].value)
    const children = []
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) children.push(...value.filter((entry) => entry && typeof entry.type === 'string'))
      else if (value && typeof value === 'object' && typeof value.type === 'string') children.push(value)
    }
    for (let index = children.length - 1; index >= 0; index--) nodes.push(children[index])
  }
  return { imports, requires }
}

function isPackagedImport(specifier) {
  return specifier.startsWith('.') || specifier.startsWith('/') || allowedRuntimeImports.has(specifier)
}

async function verifyMainBundle(outputDirectory) {
  const failures = []
  let inspectedImportCount = 0
  for (const filePath of await listJavaScriptFiles(outputDirectory)) {
    const source = await readFile(filePath, 'utf8')
    for (const specifier of runtimeSpecifiers(source).imports) {
      inspectedImportCount += 1
      if (!isPackagedImport(specifier)) failures.push(`${path.relative(outputDirectory, filePath)}: ${specifier}`)
    }
  }
  if (inspectedImportCount === 0) {
    throw new Error('The main-process bundle contained no inspectable ESM imports; its output format may have changed.')
  }
  if (failures.length > 0) {
    throw new Error(
      `The main-process bundle contains an unpackaged runtime import:\n${failures.map((failure) => `- ${failure}`).join('\n')}`
    )
  }
}

async function verifyPreloadBundle(outputDirectory) {
  const failures = []
  let inspectedRequireCount = 0
  for (const filePath of await listJavaScriptFiles(outputDirectory)) {
    const source = await readFile(filePath, 'utf8')
    for (const specifier of runtimeSpecifiers(source).requires) {
      inspectedRequireCount += 1
      if (!isPackagedImport(specifier)) failures.push(`${path.relative(outputDirectory, filePath)}: ${specifier}`)
    }
  }
  if (inspectedRequireCount === 0) {
    throw new Error('The preload bundle contained no inspectable CommonJS imports; its output format may have changed.')
  }
  if (failures.length > 0) {
    throw new Error(
      `The preload bundle contains an unpackaged runtime import:\n${failures.map((failure) => `- ${failure}`).join('\n')}`
    )
  }
}

module.exports = { verifyMainBundle, verifyPreloadBundle }

if (require.main === module) {
  const outputRoot = process.argv[2] ? path.resolve(process.argv[2]) : path.resolve(__dirname, '..', 'out')
  Promise.all([verifyMainBundle(path.join(outputRoot, 'main')), verifyPreloadBundle(path.join(outputRoot, 'preload'))])
    .then(() => console.log('[package] verified main-process and preload runtime imports'))
    .catch((error) => {
      console.error(error)
      process.exit(1)
    })
}
