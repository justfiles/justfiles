import { readFileSync } from 'node:fs'
import { dirname, extname, resolve } from 'node:path'
import { memStorage, volume } from '@justfiles/fs'
import { buildSync } from 'esbuild'
import type { Connect } from 'vite'
import { appBundleFromMemory } from './app'
import { type GetSandbox, kernel } from './kernel'

export interface HostOptions {
	id: string
	name: string
	app: string // headless bundle entry, relative to vite root
	gui: string // browser bundle entry, relative to vite root
}

const sandbox: GetSandbox = async (code) => {
	const mod = await import(
		/* @vite-ignore */ `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`
	)
	if (typeof mod.app !== 'object') throw new Error('app module must export an object named "app"')
	return { run: (action, ctx) => mod.app.dispatch(action, ctx), schemas: mod.app.schemas }
}

const compile = (entry: string) =>
	buildSync({
		entryPoints: [entry],
		absWorkingDir: dirname(entry),
		bundle: true,
		write: false,
		format: 'esm'
	}).outputFiles[0].text

const mime = (path: string) =>
	({ '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json' })[
		extname(path)
	] ?? 'application/octet-stream'

const template = readFileSync(new URL('./host.html', import.meta.url), 'utf8')
const page = (title: string) => template.split('{{title}}').join(title)

export async function createHost(
	root: string,
	opts: HostOptions
): Promise<Connect.NextHandleFunction> {
	const fs = volume(memStorage())
	const k = kernel({ fs, sandbox, clock: {} })
	const appId = await k.install(
		appBundleFromMemory({
			id: opts.id,
			name: opts.name,
			app: compile(resolve(root, opts.app)),
			gui: compile(resolve(root, opts.gui))
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
