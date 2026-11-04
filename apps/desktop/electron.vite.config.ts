import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    // ws is bundled; Vite's optional-peer stub is not the native bufferutil addon.
    define: { 'process.env.WS_NO_BUFFER_UTIL': '"1"' },
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          '@anthropic-ai/claude-agent-sdk',
          '@openai/codex-sdk',
          '@remember/shared',
          '@sentry/electron',
          'electron-updater',
          'node-diff3',
          'ws',
          'zod',
        ],
      }),
    ],
    build: {
      outDir: 'out/main',
      sourcemap: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          transcribeWorker: resolve(__dirname, 'src/main/voiceNotes/transcribeWorker.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@remember/shared', 'cuelume'] })],
    build: {
      outDir: 'out/preload',
      sourcemap: true,
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          dictationRecorder: resolve(__dirname, 'src/preload/dictationRecorder.ts'),
          sharedMicrophone: resolve(__dirname, 'src/preload/sharedMicrophone.ts'),
        },
        output: {
          entryFileNames: '[name].cjs',
          format: 'cjs',
        },
      },
    },
  },
  // The renderer is the local Next.js app in apps/web. During development the
  // Electron shell loads localhost:3000; packaged builds serve its static export
  // from the app resources.
})
