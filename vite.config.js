import { defineConfig } from 'vite'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readdirSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const html = Object.fromEntries(
  readdirSync(resolve(__dirname, 'public'))
    .filter((f) => f.endsWith('.html'))
    .map((f) => [f.replace(/\.html$/, ''), resolve(__dirname, 'public', f)])
)

export default defineConfig({
  root: 'public',
  envDir: '..',
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: { input: html }
  },
  server: {
    host: '0.0.0.0',
    port: 8080,
    open: false,
    fs: { allow: [__dirname] }
  },
  preview: {
    host: '0.0.0.0',
    port: 8080
  }
})
