import { defineConfig, defaultClientConditions } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

import { cloudflare } from "@cloudflare/vite-plugin";

// https://vite.dev/config/
export default defineConfig({
  resolve: {
    conditions: ['@justfiles/src', ...defaultClientConditions],
  },
  plugins: [tailwindcss(), react(), cloudflare()],
})