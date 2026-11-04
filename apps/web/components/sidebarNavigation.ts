export function isConversationsPath(pathname: string) {
  return (
    pathname === '/conversations' ||
    pathname.startsWith('/conversations/') ||
    pathname === '/notes' ||
    pathname.startsWith('/notes/')
  )
}

export function isWorkdaysPath(pathname: string) {
  return !isConversationsPath(pathname) && (pathname === '/' || pathname === '/day' || pathname.startsWith('/day/'))
}
