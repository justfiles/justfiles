import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'
import { memStorage, volume } from '@justfiles/fs'
import type { Connect, RunnableDevEnvironment, ViteDevServer } from 'vite'
import { isRunnableDevEnvironment } from 'vite'
import { appBundleFromMemory, type Message } from './app.ts'
import { capabilityRegistry } from './capabilities/index.ts'
import { volumeCapability } from './capabilities/volume/host.ts'
import { type GetSandbox, kernel } from './kernel.ts'

export interface DevServerOptions {
	id: string
	name: string
	description?: string
	version?: string
	icon?: string
	include?: string[]
	app: string // headless bundle entry, relative to vite root
	gui: string // browser bundle entry, relative to vite root
}

// In dev the headless app is not pre-bundled: Vite transforms and serves the
// real `src/app.ts` (and its workspace deps) through the `kernel` server
// environment's module graph (Vite Environment API). Each load re-reads the live
// module — Vite invalidates the graph on file change — so app edits take effect
// on the next dispatch without a restart. The kernel still owns trust:
// capabilities are scoped by the app's DECLARED capabilities, never by what this
// module claims at runtime.
function viteSandbox(env: RunnableDevEnvironment, appUrl: string): GetSandbox {
	return async () => {
		const { app } = await env.runner.import(appUrl)
		if (typeof app !== 'object' || app === null)
			throw new Error('app module must export an object named "app"')
		return {
			run: (action, ctx) => app.dispatch(action, ctx),
			initialState: async () => app.initialState,
			actions: async () => app.actions ?? {},
			capabilities: async () => app.capabilities ?? {},
			runProcedure: (name, params, handle) => app.runProcedure(name, params, handle),
			subscriptions: async (state) => app.subscriptions?.(state) ?? []
		}
	}
}

// The on-disk files in the app's kernel module graph (entry + its inlined
// workspace deps). Used to scope the dev reload to changes that affect the
// headless module, ignoring GUI/browser-only edits. The graph is the `kernel`
// environment's own, so it never sees client modules.
function kernelGraphFiles(env: RunnableDevEnvironment, entry: string): Set<string> {
	const files = new Set<string>()
	const queue = [...(env.moduleGraph.getModulesByFile(entry) ?? [])]
	for (let node = queue.pop(); node; node = queue.pop()) {
		if (!node.file || files.has(node.file)) continue
		files.add(node.file)
		queue.push(...node.importedModules)
	}
	return files
}

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

const mime = (path: string) =>
	MIME[extname(path).slice(1).toLowerCase()] ?? 'application/octet-stream'

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

// The dev server's local `volume` unit — the same scope→chroot policy the old
// hand-written router used (`'system'` → root, `/prefix` → prefix chroot, else
// the per-app `/data/<id>` chroot), now expressed as one `implementCapability`
// unit and routed through `capabilityRegistry`.
export async function createDevServer(
	server: ViteDevServer,
	opts: DevServerOptions
): Promise<Connect.NextHandleFunction> {
	const root = server.config.root
	const appEntry = resolve(root, opts.app)
	const appUrl = `/${relative(root, appEntry).split('\\').join('/')}`
	const env = server.environments.kernel
	if (!env || !isRunnableDevEnvironment(env))
		throw new Error('kernel environment is not runnable (Vite Environment API)')
	const fs = volume(memStorage())
	const k = kernel({
		fs,
		sandbox: viteSandbox(env, appUrl),
		clock: {},
		// The real host implementation, not a dev copy — so what an app sees here
		// (scopes, mtimes on a recursive scan, writeFile's parent creation) is what
		// it will see in frieren. The app under development is its own allowlist,
		// since a dev host has no other tenant.
		capabilities: capabilityRegistry({
			volume: volumeCapability(fs, { systemAllowlist: [opts.id] })
		})
	})
	const bundle = appBundleFromMemory({
		id: opts.id,
		name: opts.name,
		description: opts.description,
		version: opts.version,
		icon: opts.icon,
		// Placeholder: the real headless module is served by Vite (viteSandbox);
		// the kernel just needs an `app.js` entry to exist in the bundle.
		app: '// served by vite in dev\n',
		assets: publicAssets(resolve(root, 'public'))
	})
	const appId = await k.install(bundle)
	const installed = await k.app(appId)

	// Headless-app HMR. Vite re-evaluates the module on the next sandbox load, but
	// the kernel memoizes the procedure set + declared capabilities per install —
	// re-install on a change within the kernel graph to drop those caches and
	// re-warm subscriptions. State is keyed by appId, so it survives the reload.
	// Chained + deferred past the sync watcher batch so Vite invalidates first.
	let reload: Promise<unknown> = Promise.resolve()
	server.watcher.on('change', (file) => {
		if (!kernelGraphFiles(env, appEntry).has(file)) return
		reload = reload.then(() => k.install(bundle)).catch(() => {})
	})

	return async (req, res, next) => {
		try {
			const path = new URL(req.url ?? '/', 'http://localhost').pathname
			if (path === '/') {
				res.setHeader('content-type', 'text/html')
				res.end(await server.transformIndexHtml(req.url ?? '/', page(opts.name)))
				return
			}
			if (path === '/_state') {
				res.setHeader('content-type', 'application/json')
				res.end(JSON.stringify(await k.state(appId)))
				return
			}
			if (path === '/_subscribe') {
				res.setHeader('content-type', 'text/event-stream')
				res.setHeader('cache-control', 'no-cache')
				res.setHeader('connection', 'keep-alive')
				const send = (state: unknown) => res.write(`data: ${JSON.stringify(state)}\n\n`)
				// Snapshot first so reconnecting subscribers reconcile immediately.
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
					const result = await k.dispatch(appId, (await readJson(req)) as Message)
					res.setHeader('content-type', 'application/json')
					// A procedure may legitimately resolve with nothing (`mkdir`, `remove`).
					// `JSON.stringify(undefined)` is undefined — an empty body, which the
					// client's `r.json()` rejects — so send explicit `null`.
					res.end(JSON.stringify(result ?? null))
				} catch (err) {
					res.statusCode = 400
					res.end(err instanceof Error ? err.message : String(err))
				}
				return
			}
			const asset = path.slice(1)
			const data = asset ? await installed.read(asset).catch(() => null) : null
			if (!data) return next()
			res.setHeader('content-type', mime(asset as string))
			res.end(Buffer.from(data))
		} catch (err) {
			next(err)
		}
	}
}
