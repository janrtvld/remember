import path from 'node:path'

export function resolvePackagedWebPath(root: string, pathname: string) {
  const decodedPathname = decodeURIComponent(pathname)
  const relative = decodedPathname === '/' ? 'index.html' : decodedPathname.replace(/^\/+/, '')
  const fileRelative =
    decodedPathname === '/' || path.extname(relative) ? relative : `${relative.replace(/\/+$/, '')}/index.html`
  const target = path.resolve(root, fileRelative)
  return target === root || target.startsWith(`${root}${path.sep}`) ? target : null
}
