import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { ElectrobunConfig } from 'electrobun'
import engine from '../package.json'

// Developer ID signing and notarization switch on when the identity is in the environment
// (ELECTROBUN_DEVELOPER_ID, ELECTROBUN_TEAMID, plus Apple ID or API-key credentials).
const signing = !!process.env.ELECTROBUN_DEVELOPER_ID

export default {
  app: {
    name: 'Octonoesis',
    identifier: 'dev.octonoesis.desktop',
    version: engine.version,
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
      // Packaged builds run this bundle (scripts/build-engine.ts); dev builds use the checkout.
      ...(existsSync(fileURLToPath(new URL('engine/host.js', import.meta.url)))
        ? { engine: 'engine' }
        : {}),
    },
    // Vite output is copied into views:// by each build.
    watchIgnore: ['dist/**', 'engine/**'],
    mac: {
      bundleCEF: false,
      icons: 'icon.iconset',
      codesign: signing,
      notarize: signing,
    },
    linux: {
      bundleCEF: false,
    },
    win: {
      bundleCEF: false,
    },
  },
} satisfies ElectrobunConfig
