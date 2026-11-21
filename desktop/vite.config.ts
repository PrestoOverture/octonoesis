import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { electrobunViteAliases } from './.hutch/devkit/api/config/electrobun-vite'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: electrobunViteAliases(resolve(__dirname, '.hutch/devkit')),
  },
  root: 'src/mainview',
  base: './',
  build: {
    outDir: '../../dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
  },
})
