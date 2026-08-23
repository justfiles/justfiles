import { readFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { extname, join } from 'node:path'
import type { Plugin, ResolvedConfig } from 'vite'
import type { AppManifest } from './app.ts'
import { builtinStoreFromFs } from './appstore.fs.ts'
import {
	appHash,
	type ReleaseManifest,
	releaseManifest,
	STORE_SCHEMA,
	type StoreIndex
} from './appstore.protocol.ts'

const PORT = 4173
const CONTENT_TYPES: Record<string, string> = {
	'.avif': 'image/avif',
	'.css': 'text/css',
	'.gif': 'image/gif',
	'.html': 'text/html',
	'.ico': 'image/x-icon',
	'.jpeg': 'image/jpeg',
	'.jpg': 'image/jpeg',
	'.js': 'text/javascript',
	'.json': 'application/json',
	'.mjs': 'text/javascript',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.wasm': 'application/wasm',
	'.webp': 'image/webp',
	'.woff': 'font/woff',
	'.woff2': 'font/woff2'
}

export function localStore(port = PORT): Plugin {
	let config: ResolvedConfig
	let server: Server | undefined
	let origin = ''
	let release: ReleaseManifest | undefined
	return {
		name: 'kernel-host-local-store',
		apply: 'build',
		configResolved(resolved) {
			config = resolved
		},
		// App plugins can write files named by `include` during closeBundle.
		// Read dist after all of those hooks finish.
		closeBundle: {
			order: 'post',
			sequential: true,
			async handler() {
				if (!config.build.watch) return
				const root = join(config.root, config.build.outDir)
				release = await buildRelease(root)
				if (!server) {
					const started = createServer((request, response) => {
						void serve(request, response, { root, origin, release }).catch(() =>
							fail(response, 400, 'bad request')
						)
					})
					origin = await listen(started, port)
					server = started
					config.logger.info(`\n  ➜  App store: ${origin}/store.json`)
				}
			}
		},
		async closeWatcher() {
			if (!server) return
			const current = server
			await new Promise<void>((resolve, reject) =>
				current.close((error) => (error ? reject(error) : resolve()))
			)
			server = undefined
		}
	}
}

async function buildRelease(root: string): Promise<ReleaseManifest> {
	const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')) as AppManifest
	const store = await builtinStoreFromFs([root])
	const app = (await store.builtins())[0]
	if (!app) throw new Error('local store: build produced no app')
	return releaseManifest(manifest, {
		id: app.id,
		version: app.version,
		hash: await appHash(app.files),
		files: app.files.filter((file) => file.path !== 'manifest.json')
	})
}

async function serve(
	request: IncomingMessage,
	response: ServerResponse,
	state: { root: string; origin: string; release: ReleaseManifest | undefined }
): Promise<void> {
	response.setHeader('Access-Control-Allow-Origin', '*')
	if (request.method !== 'GET') return fail(response, 405, 'method not allowed')
	const release = state.release
	if (!release) return fail(response, 503, 'watch build is not ready')

	const path = new URL(request.url ?? '/', state.origin).pathname
	const requestEtag = request.headers['if-none-match']
	const etag = `"${release.hash}"`
	if (path === '/manifest.json') return json(response, release, requestEtag, etag)
	if (path === '/store.json') {
		const store: StoreIndex = {
			schema: STORE_SCHEMA,
			apps: [
				{
					id: release.id,
					name: release.name,
					description: release.description,
					version: release.version,
					iconUrl: release.icon ? new URL(release.icon, state.origin).href : undefined,
					manifestUrl: new URL('manifest.json', state.origin).href
				}
			]
		}
		return json(response, store, requestEtag, etag)
	}

	const filePath = decodeURIComponent(path.slice(1))
	const file = release.files.find(({ path }) => path === filePath)
	if (!file) return fail(response, 404, 'not found')
	const fileEtag = `"${file.hash}"`
	if (fresh(response, requestEtag, fileEtag)) return
	try {
		const bytes = await readFile(join(state.root, ...file.path.split('/')))
		response.statusCode = 200
		response.setHeader('Content-Type', contentType(file.path))
		response.end(bytes)
	} catch {
		fail(response, 503, 'watch build is not ready')
	}
}

function json(
	response: ServerResponse,
	body: unknown,
	requestEtag: string | undefined,
	etag: string
) {
	if (fresh(response, requestEtag, etag)) return
	response.statusCode = 200
	response.setHeader('Content-Type', 'application/json')
	response.end(JSON.stringify(body))
}

function fresh(response: ServerResponse, requestEtag: string | undefined, etag: string): boolean {
	response.setHeader('Cache-Control', 'no-cache')
	response.setHeader('ETag', etag)
	if (requestEtag !== etag) return false
	response.statusCode = 304
	response.end()
	return true
}

function fail(response: ServerResponse, status: number, message: string): void {
	response.statusCode = status
	response.setHeader('Cache-Control', 'no-store')
	response.setHeader('Content-Type', 'text/plain')
	response.removeHeader('ETag')
	response.end(message)
}

function contentType(path: string): string {
	return CONTENT_TYPES[extname(path)] ?? 'application/octet-stream'
}

function listen(server: Server, port: number): Promise<string> {
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
