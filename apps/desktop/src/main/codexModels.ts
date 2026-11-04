import { app } from 'electron'
import { startCodexAppServer } from './codexAuth'
import { codexModelCatalog, fetchCodexModels } from './codexModelCatalog'
import { bundledCodexExecutable } from './codexRuntime'
import { isOfflineMode, requireNetworkAccess } from './networkAccess'

export function getCodexModels() {
  const executable = bundledCodexExecutable()
  return codexModelCatalog.get(
    app.getPath('userData'),
    executable && !isOfflineMode()
      ? async () => {
          requireNetworkAccess()
          const server = await startCodexAppServer(
            executable,
            () => {},
            () => {}
          )
          try {
            return await fetchCodexModels((method, params) => {
              requireNetworkAccess()
              return server.request(method, params)
            })
          } finally {
            server.close()
          }
        }
      : null
  )
}
