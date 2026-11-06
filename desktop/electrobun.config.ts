import { fileURLToPath } from 'node:url'
import type { ElectrobunConfig } from 'electrobun'

export default {
  app: {
    name: 'Octonoesis',
    identifier: 'dev.octonoesis.desktop',
    version: '0.0.1',
  },
  build: {
    mainProcess: 'bun',
    bun: {
      entrypoint: 'src/bun/index.ts',
      define: {
        OCTONOESIS_DEV_ENGINE_ROOT: JSON.stringify(fileURLToPath(new URL('../', import.meta.url))),
      },
    },
    // Vite builds to dist/, we copy from there
    copy: {
      'dist/index.html': 'views/mainview/index.html',
      'dist/assets': 'views/mainview/assets',
    },
    // Vite output is copied into views:// by each build.
    watchIgnore: ['dist/**'],
    mac: {
      bundleCEF: false,
    },
    linux: {
      bundleCEF: false,
    },
    win: {
      bundleCEF: false,
    },
  },
} satisfies ElectrobunConfig
