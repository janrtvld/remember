import { app, shell } from 'electron'
import { type CodexAppServer, createCodexAppServer, initializeCodexServer } from './codexAppServer'
import { codexModelCatalog } from './codexModelCatalog'
import { codexProcessEnvironment } from './codexRuntime'
import { isOfflineMode, requireNetworkAccess } from './networkAccess'

type LoginSession = {
  authUrl: string
  loginId: string
  server: CodexAppServer
}

let loginSession: LoginSession | null = null

export async function openCodexChatGptLogin(executable: string) {
  requireNetworkAccess()
  if (loginSession && !loginSession.server.isClosed()) {
    requireNetworkAccess()
    await shell.openExternal(loginSession.authUrl)
    return
  }

  const server = await startCodexAppServer(executable, handleNotification, () => {
    if (loginSession?.server === server) loginSession = null
  })
  let loginId: string | null = null
  try {
    requireNetworkAccess()
    const result = asObject(
      await server.request('account/login/start', {
        type: 'chatgpt',
      })
    )
    const authUrl = typeof result.authUrl === 'string' ? result.authUrl : null
    loginId = typeof result.loginId === 'string' ? result.loginId : null
    if (!authUrl || !loginId) throw new Error('codex-login-url-missing')

    loginSession = { authUrl, loginId, server }
    requireNetworkAccess()
    await shell.openExternal(authUrl)
  } catch (error) {
    if (loginSession?.server === server) loginSession = null
    if (loginId && !isOfflineMode()) {
      await server.request('account/login/cancel', { loginId }).catch(() => undefined)
    }
    server.close()
    throw error
  }
}

export function cancelCodexChatGptLogin() {
  const session = loginSession
  loginSession = null
  if (!session) return Promise.resolve()
  if (isOfflineMode()) {
    session.server.close()
    return Promise.resolve()
  }
  return session.server
    .request('account/login/cancel', { loginId: session.loginId })
    .catch(() => undefined)
    .finally(() => session.server.close())
}

function handleNotification(method: string, params: unknown) {
  if (method !== 'account/login/completed') return
  codexModelCatalog.invalidate()
  const session = loginSession
  loginSession = null
  if (!session) return

  const result = asObject(params)
  if (result.success !== true && result.error) console.warn(`[codex-auth] ${String(result.error)}`)
  session.server.close()
}

export async function startCodexAppServer(
  executable: string,
  onNotification: (method: string, params: unknown) => void,
  onClose: () => void
) {
  const environment = await codexProcessEnvironment(executable)
  requireNetworkAccess()
  const server = createCodexAppServer({ executable, env: environment, onNotification, onClose })
  try {
    await initializeCodexServer(server, app.getVersion())
    return server
  } catch (error) {
    server.close()
    throw error
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}
