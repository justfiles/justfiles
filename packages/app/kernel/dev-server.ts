import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { memStorage, volume } from '@justfiles/fs'
import { buildSync } from 'esbuild'
import type { Connect } from 'vite'
import { type Action, appBundleFromMemory } from './app'
import { type GetSandbox, kernel } from './kernel'

export interface DevServerOptions {
	id: string
	name: string
	description?: string
	version?: string
	icon?: string
	app: string // headless bundle entry, relative to vite root
	gui: string // browser bundle entry, relative to vite root
}

const sandbox: GetSandbox = async ({ code }) => {
	const mod = await import(
		/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
	)
	if (typeof mod.app !== 'object') throw new Error('app module must export an object named "app"')
	return {
		run: (action, ctx) => mod.app.dispatch(action, ctx),
		actions: async () => mod.app.actions ?? {}
	}
}

const compile = (entry: string) =>
	buildSync({
		entryPoints: [entry],
		absWorkingDir: dirname(entry),
		bundle: true,
		write: false,
		format: 'esm'
	}).outputFiles[0].text

const MIME: Record<string, string> = {
	html: 'text/html; charset=utf-8',
	js: 'application/javascript; charset=utf-8',
	mjs: 'application/javascript; charset=utf-8',
	css: 'text/css; charset=utf-8',
	json: 'application/json; charset=utf-8',
	svg: 'image/svg+xml',
	wasm: 'application/wasm',
	wad: 'application/octet-stream',
	cfg: 'text/plain; charset=utf-8',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	webp: 'image/webp'
}

const mime = (path: string) => MIME[extname(path).slice(1).toLowerCase()] ?? 'application/octet-stream'

const template = readFileSync(new URL('./dev-server.html', import.meta.url), 'utf8')
const page = (title: string) => template.split('{{title}}').join(title)

const readJson = (req: { on: NodeJS.ReadableStream['on'] }): Promise<unknown> =>
	new Promise((ok, fail) => {
		let body = ''
		req.on('data', (c) => {
			body += c
		})
		req.on('end', () => {
			try {
				ok(body ? JSON.parse(body) : {})
			} catch (e) {
				fail(e)
			}
		})
		req.on('error', fail)
	})

function* walkFiles(dir: string, prefix = ''): Iterable<string> {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name)
		const rel = prefix ? join(prefix, name) : name
		const stat = statSync(full)
		if (stat.isDirectory()) yield* walkFiles(full, rel)
		else if (stat.isFile()) yield rel
	}
}

function publicAssets(dir: string): Record<string, Uint8Array> {
	if (!existsSync(dir)) return {}
	const out: Record<string, Uint8Array> = {}
	for (const path of walkFiles(dir)) out[path] = readFileSync(join(dir, path))
	return out
}

export async function createDevServer(
	root: string,
	opts: DevServerOptions
): Promise<Connect.NextHandleFunction> {
	const fs = volume(memStorage())
	const k = kernel({ fs, sandbox, clock: {} })
	const appId = await k.install(
		appBundleFromMemory({
			id: opts.id,
			name: opts.name,
			description: opts.description,
			version: opts.version,
			icon: opts.icon,
			app: compile(resolve(root, opts.app)),
			gui: compile(resolve(root, opts.gui)),
			assets: publicAssets(resolve(root, 'public'))
		})
	)
	const installed = await k.app(appId)

	return async (req, res, next) => {
		try {
			const path = new URL(req.url ?? '/', 'http://localhost').pathname
			if (path === '/') {
				res.setHeader('content-type', 'text/html')
				res.end(page(opts.name))
				return
			}
			if (path === '/_subscribe') {
				res.setHeader('content-type', 'text/event-stream')
				res.setHeader('cache-control', 'no-cache')
				res.setHeader('connection', 'keep-alive')
				const send = (state: unknown) => res.write(`data: ${JSON.stringify(state)}\n\n`)
				// Snapshot first so the GUI reconciles immediately; an
				// app that never dispatched has no state — the GUI keeps
				// the bootstrap state it mounted with until the first push.
				const initial = await k.state(appId)
				if (initial !== undefined) send(initial)
				const off = k.subscribe((e) => {
					if (e.type === 'app.update' && e.appId === appId) send(e.state)
				})
				req.on('close', off)
				return
			}
			if (path === '/_dispatch' && req.method === 'POST') {
				try {
					const result = await k.dispatch(appId, (await readJson(req)) as Action)
					res.setHeader('content-type', 'application/json')
					res.end(JSON.stringify(result))
				} catch (err) {
					res.statusCode = 400
					res.end(err instanceof Error ? err.message : String(err))
				}
				return
			}
			const asset = path === '/app.js' ? installed.manifest.gui : path.slice(1)
			const data = asset ? await installed.read(asset).catch(() => null) : null
			if (!data) return next()
			res.setHeader('content-type', mime(asset as string))
			res.end(Buffer.from(data))
		} catch (err) {
			next(err)
		}
	}
}
