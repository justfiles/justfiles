import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { chroot, memStorage, type Volume, volume } from '@justfiles/fs'
import { FileType } from '@justfiles/fs/types'
import { buildSync } from 'esbuild'
import type { Connect, ViteDevServer } from 'vite'
import { appBundleFromMemory, type Message } from './app.ts'
import { type Capability, capabilityRegistry, implementCapability } from './capabilities/index.ts'
import { type VolumeEntry, volume as volumeCap } from './capabilities/volume/index.ts'
import { type GetSandbox, kernel } from './kernel.ts'

export interface DevServerOptions {
	id: string
	name: string
	description?: string
	version?: string
	icon?: string
	app: string // headless bundle entry, relative to vite root
	gui: string // browser bundle entry, relative to vite root
}

function sandboxFor(): GetSandbox {
	return async ({ code }) => {
		const mod = await import(
			/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
		)
		if (typeof mod.app !== 'object') throw new Error('app module must export an object named "app"')
		return {
			run: (action, ctx) => mod.app.dispatch(action, ctx),
			initialState: async () => mod.app.initialState,
			actions: async () => mod.app.actions ?? {},
			capabilities: async () => mod.app.capabilities ?? {},
			runProcedure: (name, params, handle) => mod.app.runProcedure(name, params, handle),
			subscriptions: async (state) => mod.app.subscriptions?.(state) ?? []
		}
	}
}

const compile = (entry: string) => {
	const output = buildSync({
		entryPoints: [entry],
		absWorkingDir: dirname(entry),
		bundle: true,
		write: false,
		format: 'esm',
		jsx: 'automatic'
	}).outputFiles[0]
	if (!output) throw new Error(`failed to compile ${entry}`)
	return output.text
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
function devVolume(fs: Volume): Capability {
	const bind = async (ctx: { appId: string; scopes: readonly string[] }): Promise<Volume> => {
		const prefix = ctx.scopes.find((s) => s.startsWith('/'))
		const root = ctx.scopes.includes('system') ? null : (prefix ?? `/data/${ctx.appId}`)
		const vol = root ? chroot(fs, root) : fs
		if (root && !(await fs.exists(root))) await fs.mkdir(root, { recursive: true })
		return vol
	}
	return implementCapability(volumeCap, {
		stat: async (ctx, path) => (await bind(ctx)).stat(path),
		lstat: async (ctx, path) => (await bind(ctx)).lstat(path),
		exists: async (ctx, path) => (await bind(ctx)).exists(path),
		getXattr: async (ctx, path, name) => (await bind(ctx)).getXattr(path, name),
		setXattr: async (ctx, path, name, value) => (await bind(ctx)).setXattr(path, name, value),
		listXattr: async (ctx, path) => (await bind(ctx)).listXattr(path),
		removeXattr: async (ctx, path, name) => (await bind(ctx)).removeXattr(path, name),
		readFile: async (ctx, path) => (await bind(ctx)).readFile(path),
		writeFile: async (ctx, path, data) => {
			const vol = await bind(ctx)
			await mkdirParent(vol, path)
			await vol.writeFile(path, data)
		},
		appendFile: async (ctx, path, data) => (await bind(ctx)).appendFile(path, data),
		mkdir: async (ctx, path, opts) => (await bind(ctx)).mkdir(path, opts),
		readdir: async (ctx, path) => (await bind(ctx)).readdir(path),
		rm: async (ctx, path, opts) => (await bind(ctx)).rm(path, opts),
		rename: async (ctx, oldPath, newPath) => (await bind(ctx)).rename(oldPath, newPath),
		cp: async (ctx, src, dest, opts) => (await bind(ctx)).cp(src, dest, opts),
		symlink: async (ctx, target, path) => (await bind(ctx)).symlink(target, path),
		readlink: async (ctx, path) => (await bind(ctx)).readlink(path),
		chmod: async (ctx, path, mode) => (await bind(ctx)).chmod(path, mode),
		utimes: async (ctx, path, mtimeNs) => (await bind(ctx)).utimes(path, mtimeNs),
		scan: async (ctx, { path, recursive }) => {
			const vol = await bind(ctx)
			return recursive === true ? scanTree(vol, path) : scanDir(vol, path)
		},
		watch: async (ctx, emit, { path }) => (await bind(ctx)).watch(path, emit)
	})
}

async function mkdirParent(vol: Volume, path: string): Promise<void> {
	const parent = path.split('/').slice(0, -1).join('/')
	if (parent) await vol.mkdir(parent, { recursive: true })
}

async function scanDir(vol: Volume, path: string): Promise<VolumeEntry[]> {
	if (!(await vol.exists(path))) return []
	const base = path.endsWith('/') ? path.slice(0, -1) : path
	return (await vol.readdir(path))
		.filter((entry) => entry.type !== FileType.Symlink)
		.map((entry) => ({
			path: `${base}/${entry.name}`,
			type: entry.type === FileType.Directory ? 'dir' : 'file'
		}))
}

async function scanTree(vol: Volume, path: string): Promise<VolumeEntry[]> {
	if (!(await vol.exists(path))) return []
	const out: VolumeEntry[] = []
	await vol.scan(path, async (entryPath, stat) => {
		if (entryPath === path || stat.type === FileType.Symlink) return
		out.push({ path: entryPath, type: stat.type === FileType.Directory ? 'dir' : 'file' })
	})
	return out
}

export async function createDevServer(
	server: ViteDevServer,
	opts: DevServerOptions
): Promise<Connect.NextHandleFunction> {
	const root = server.config.root
	const fs = volume(memStorage())
	const k = kernel({
		fs,
		sandbox: sandboxFor(),
		clock: {},
		capabilities: capabilityRegistry({ volume: devVolume(fs) })
	})
	const appId = await k.install(
		appBundleFromMemory({
			id: opts.id,
			name: opts.name,
			description: opts.description,
			version: opts.version,
			icon: opts.icon,
			app: compile(resolve(root, opts.app)),
			assets: publicAssets(resolve(root, 'public'))
		})
	)
	const installed = await k.app(appId)

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
					res.end(JSON.stringify(result))
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
