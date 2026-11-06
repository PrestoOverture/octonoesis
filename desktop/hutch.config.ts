// @hutch cli=0.29.0 cottontail=0.7.3
export default {
  scripts: {
    install: ['hutch', 'install', '--frozen-lockfile'],
    start: 'hutch electrobun prepare && hutch pm exec -- vite build && hutch electrobun dev',
    dev: 'hutch electrobun prepare && hutch pm exec -- vite build && hutch electrobun dev --watch',
    build:
      'hutch electrobun prepare && hutch pm exec -- vite build && hutch electrobun build --env=stable',
    'build:canary':
      'hutch electrobun prepare && hutch pm exec -- vite build && hutch electrobun build --env=canary',
  },
  electrobun: {
    version: '2.0.6',
  },
}
