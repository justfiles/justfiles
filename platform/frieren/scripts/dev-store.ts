import { readFile, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join } from 'node:path'
import type { AppManifest } from '@justfiles/app'
import { builtinStoreFromFs } from '@justfiles/app/appstore/fs'
import {
	appHash,
	type ReleaseManifest,
	releaseManifest,
	STORE_SCHEMA,
	type StoreIndex
} from '@justfiles/app/appstore/protocol'

const CONTENT_TYPES: Record<string, string> = {
	'.avif': 'image/avif',
	'.css': 'text/css',
	'.gif': 'image/gif',
	'.html': 'text/html; charset=utf-8',
	'.jpeg': 'image/jpeg',
	'.jpg': 'image/jpeg',
	'.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json',
	'.mjs': 'text/javascript; charset=utf-8',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.wasm': 'application/wasm',
	'.webp': 'image/webp',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2'
}

interface AppRelease {
	root: string
	release: ReleaseManifest
}

interface Snapshot {
	apps: Map<string, AppRelease>
	stamp: string
}

export interface DevStore {
	url: string
	close(): Promise<void>
}

export async function startDevStore(roots: string[], port = 4173): Promise<DevStore> {
	let snapshot = await load(roots)
	const refresh = async () => {
		try {
			const stamp = await buildStamp(roots)
			if (stamp !== snapshot.stamp) snapshot = await load(roots, stamp)
		} catch {}
		return snapshot
	}
	const server = createServer((request, response) => {
		void refresh()
			.then((current) => serve(request, response, current))
			.catch((error) => fail(response, 500, String(error)))
	})
	const url = await listen(server, port)
	return {
		url: `${url}/store.json`,
		close: () =>
			new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
	}
}

async function load(roots: string[], stamp?: string): Promise<Snapshot> {
	const store = await builtinStoreFromFs(roots)
	const catalog = new Map((await store.builtins()).map((app) => [app.id, app]))
	const apps = new Map<string, AppRelease>()
	for (const root of roots) {
		const authored = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as AppManifest
		const app = catalog.get(authored.id)
		if (!app) throw new Error(`dev app store: missing app for ${root}`)
		const release = releaseManifest(authored, {
			id: app.id,
			version: app.version,
			hash: await appHash(app.files),
			files: app.files.filter((file) => file.path !== 'manifest.json')
		})
		apps.set(app.id, { root, release })
	}
	return { apps, stamp: stamp ?? (await buildStamp(roots)) }
}

async function serve(
	request: IncomingMessage,
	response: ServerResponse,
	snapshot: Snapshot
): Promise<void> {
	response.setHeader('Access-Control-Allow-Origin', '*')
	response.setHeader('Cache-Control', 'no-cache')
	if (request.method !== 'GET') return fail(response, 405, 'method not allowed')
	const path = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname)
	if (path === '/store.json') return json(response, storeIndex(snapshot, request))

	const [, prefix, id, ...parts] = path.split('/')
	const app = prefix === 'apps' && id ? snapshot.apps.get(id) : undefined
	if (!app) return fail(response, 404, 'not found')
	const file = parts.join('/')
	if (file === 'manifest.json') return json(response, app.release)
	const entry = app.release.files.find(({ path }) => path === file)
	if (!entry) return fail(response, 404, 'not found')
	try {
		response.statusCode = 200
		response.setHeader('Content-Type', CONTENT_TYPES[extname(file)] ?? 'application/octet-stream')
		response.end(await readFile(join(app.root, ...file.split('/'))))
	} catch {
		fail(response, 503, 'build is not ready')
	}
}

function storeIndex(snapshot: Snapshot, request: IncomingMessage): StoreIndex {
	const origin = `http://${request.headers.host}`
	return {
		schema: STORE_SCHEMA,
		apps: [...snapshot.apps.values()].map(({ release }) => ({
			id: release.id,
			name: release.name,
			description: release.description,
			version: release.version,
			hash: release.hash,
			iconUrl: release.icon ? `${origin}/apps/${release.id}/${release.icon}` : undefined,
			manifestUrl: `${origin}/apps/${release.id}/manifest.json`
		}))
	}
}

async function buildStamp(roots: string[]): Promise<string> {
	return (
		await Promise.all(
			roots.map(async (root) => {
				const info = await stat(join(root, 'manifest.json'))
				return `${info.mtimeMs}:${info.size}`
			})
		)
	).join('|')
}

function json(response: ServerResponse, body: unknown): void {
	response.statusCode = 200
	response.setHeader('Content-Type', 'application/json')
	response.end(JSON.stringify(body))
}

function fail(response: ServerResponse, status: number, message: string): void {
	response.statusCode = status
	response.setHeader('Content-Type', 'text/plain; charset=utf-8')
	response.end(message)
}

function listen(server: ReturnType<typeof createServer>, port: number): Promise<string> {
	return new Promise((resolve, reject) => {
		server.once('error', reject)
		server.listen(port, 'localhost', () => {
			server.off('error', reject)
			const address = server.address()
			if (!address || typeof address === 'string') return reject(new Error('missing server port'))
			resolve(`http://localhost:${address.port}`)
		})
	})
}
