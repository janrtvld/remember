import { bindings, defineConfig, defineWorker } from 'cf/config'

export default defineConfig({
  accountId: 'd4ff4b8dc0b7e097863aa5f4d8bec450',
  worker: defineWorker({
    name: 'remember-site',
    workersDev: true,
    domains: ['remember.computer', 'www.remember.computer'],
    observability: { enabled: true, redactQueryString: true },
    entrypoint: 'vinext/server/fetch-handler',
    compatibilityDate: '2026-10-29',
    compatibilityFlags: ['nodejs_compat'],
    assets: {
      htmlHandling: 'none',
      notFoundHandling: 'none',
      runWorkerFirst: ['/*', '!/_next/static/*', '!/*/_next/static/*'],
    },
    env: {
      ASSETS: bindings.assets(),
    },
  }),
})
