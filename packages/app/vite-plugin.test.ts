import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Plugin } from 'vite'
import { expect, test } from 'vitest'
import { FORMAT_VERSION } from './format'
import { hostApps } from './vite-plugin'

const loadApps = (plugin: Plugin) => {
	const load = plugin.load
	if (typeof load !== 'function') throw new Error('missing load hook')
	return load.call({} as never, '\0virtual:@justfiles/apps')
}

const withApp = async (
	manifest: unknown,
	files: Record<string, string> = { 'index.html': '<!doctype html>' }
) => {
	const cwd = process.cwd()
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'host-apps-'))
	try {
		process.chdir(tmp)
		const contentDir = path.join(tmp, 'node_modules', 'hello-app', 'dist')
		fs.mkdirSync(contentDir, { recursive: true })
		fs.writeFileSync(path.join(tmp, 'package.json'), '{}')
		fs.writeFileSync(
			path.join(tmp, 'node_modules', 'hello-app', 'package.json'),
			JSON.stringify({ main: 'dist/manifest.json' })
		)
		fs.writeFileSync(path.join(contentDir, 'manifest.json'), JSON.stringify(manifest))
		for (const [name, body] of Object.entries(files)) {
			const file = path.join(contentDir, name)
			fs.mkdirSync(path.dirname(file), { recursive: true })
			fs.writeFileSync(file, body)
		}
		return await loadApps(hostApps(['hello-app']))
	} finally {
		process.chdir(cwd)
		fs.rmSync(tmp, { recursive: true, force: true })
	}
}

test('hostApps accepts a minimal valid manifest', async () => {
	const code = await withApp({ format: FORMAT_VERSION, name: 'Hello', entry: 'index.html' })
	expect(String(code)).toContain('Hello')
})

test('hostApps rejects missing required manifest fields', async () => {
	await expect(withApp({ format: FORMAT_VERSION, entry: 'index.html' })).rejects.toThrow(
		/hostApps: hello-app has invalid manifest/
	)
})

test('hostApps rejects invalid permissions', async () => {
	await expect(
		withApp({
			format: FORMAT_VERSION,
			name: 'Hello',
			entry: 'index.html',
			permissions: ['volume', 'network']
		})
	).rejects.toThrow(/hostApps: hello-app has invalid manifest/)
})

test('hostApps rejects invalid entry paths', async () => {
	await expect(
		withApp({ format: FORMAT_VERSION, name: 'Hello', entry: '../index.html' })
	).rejects.toThrow(/hostApps: hello-app entry escapes/)
	await expect(
		withApp({ format: FORMAT_VERSION, name: 'Hello', entry: 'https://example.com/' })
	).rejects.toThrow(/hostApps: hello-app entry must be a safe relative path/)
})

test('hostApps rejects missing entry files', async () => {
	await expect(
		withApp({ format: FORMAT_VERSION, name: 'Hello', entry: 'missing.html' })
	).rejects.toThrow(/hostApps: hello-app entry file does not exist/)
})
