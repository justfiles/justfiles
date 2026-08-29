import path from 'node:path'
import { defineConfig } from 'vite'

export default defineConfig({
	root: path.resolve(__dirname, '../avatar-dev'),
	publicDir: false,
	server: { open: '/' }
})
