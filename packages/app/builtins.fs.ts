import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { AppManifest } from './app.ts'
import { safeBundlePath } from './app.ts'
import type { AppStore, CatalogApp } from './builtins.ts'

// Re-exported so `/builtins/fs` consumers get the abstraction from one import.
export type { AppStore } from './builtins.ts'

const SKIP = new Set(['bundle.js', 'bundle.d.ts'])

// A packaged built-in AppStore: reads app files straight off disk (Node/Bun
// hosts — spud-mac's bundled resources, or the dev `dist` dirs). It carries only
// built-ins, so `latest(id)` resolves to a built-in or null.
export async function builtinStoreFromFs(roots: readonly string[]): Promise<AppStore> {
	const rootById = new Map<string, string>()
	const filesById = new Map<string, Set<string>>()
	const byId = new Map<string, CatalogApp>()

	for (const root of roots) {
		const manifest = await readManifest(root)
		if (rootById.has(manifest.id)) throw new Error(`builtins: duplicate app id: ${manifest.id}`)
		const files = await bundleFiles(root, manifest)
		rootById.set(manifest.id, root)
		filesById.set(manifest.id, new Set(files.keys()))
		byId.set(manifest.id, toCatalogApp(manifest, files))
	}

	return {
		async builtins() {
			return [...byId.values()]
		},
		async latest(id) {
			return byId.get(id) ?? null
		},
		async read(app, path) {
			const root = rootById.get(app.id)
			const rel = safeBundlePath(path)
			if (!root || !filesById.get(app.id)?.has(rel)) {
				throw new Error(`builtin not found: ${app.id}/${path}`)
			}
			return readFile(join(root, ...rel.split('/')))
		}
	}
}

async function readManifest(root: string): Promise<AppManifest> {
	let raw: unknown
	try {
		raw = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
	} catch (error) {
		throw new Error(`builtins: ${root} has no manifest.json (build the app first)`, {
			cause: error
		})
	}
	const manifest = raw as Record<string, unknown>
	if (
		typeof manifest.id !== 'string' ||
		typeof manifest.name !== 'string' ||
		typeof manifest.app !== 'string'
	) {
		throw new Error(`builtins: ${root}/manifest.json must declare string id, name and app`)
	}
	for (const field of ['description', 'version', 'icon', 'gui', 'cli'] as const) {
		if (manifest[field] !== undefined && typeof manifest[field] !== 'string') {
			throw new Error(`builtins: ${root}/manifest.json ${field} must be a string`)
		}
	}
	if (
		manifest.include !== undefined &&
		(!Array.isArray(manifest.include) ||
			!manifest.include.every((item) => typeof item === 'string'))
	) {
		throw new Error(`builtins: ${root}/manifest.json include must be a string array`)
	}
	return manifest as unknown as AppManifest
}

async function bundleFiles(root: string, manifest: AppManifest): Promise<Map<string, Uint8Array>> {
	const allFiles = await walk(root)
	const entries = manifestEntries(manifest)
	const includes = (manifest.include ?? []).map(safeGlob)
	const selected = new Map<string, Uint8Array>()

	for (const path of [...allFiles].sort()) {
		if (SKIP.has(path)) continue
		if (!entries.has(path) && !includes.some((pattern) => globMatches(pattern, path))) continue
		selected.set(path, await readFile(join(root, ...path.split('/'))))
	}
	for (const entry of entries) {
		if (!selected.has(entry)) throw new Error(`builtins: ${manifest.id} missing ${entry}`)
	}
	return selected
}

function manifestEntries(manifest: AppManifest): Set<string> {
	return new Set(
		['manifest.json', manifest.app, manifest.gui, manifest.cli, manifest.icon]
			.filter((path): path is string => !!path)
			.map(safeBundlePath)
	)
}

async function walk(root: string, dir = root, into = new Set<string>()): Promise<Set<string>> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const abs = join(dir, entry.name)
		if (entry.isDirectory()) await walk(root, abs, into)
		else if (entry.isFile()) into.add(relative(root, abs).split(sep).join('/'))
	}
	return into
}

function toCatalogApp(manifest: AppManifest, files: Map<string, Uint8Array>): CatalogApp {
	return {
		id: manifest.id,
		name: manifest.name,
		version: manifest.version ?? '0.0.0',
		icon: manifest.icon,
		files: [...files]
			.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
			.map(([path, bytes]) => ({
				path,
				hash: `sha256-${createHash('sha256').update(bytes).digest('hex')}`,
				size: bytes.byteLength
			}))
	}
}

function safeGlob(pattern: string): string {
	const normalized = pattern.split('\\').join('/')
	if (!normalized || normalized.includes('\0') || normalized.startsWith('/')) {
		throw new Error(`invalid builtin include pattern: ${pattern}`)
	}
	const parts = normalized.split('/')
	if (parts.some((part) => !part || part === '.' || part === '..')) {
		throw new Error(`invalid builtin include pattern: ${pattern}`)
	}
	return parts.join('/')
}

function globMatches(pattern: string, path: string): boolean {
	const patternParts = pattern.split('/')
	const pathParts = path.split('/')
	const match = (patternIndex: number, pathIndex: number): boolean => {
		const patternPart = patternParts[patternIndex]
		if (patternPart === undefined) return pathIndex === pathParts.length
		if (patternPart === '**') {
			return (
				match(patternIndex + 1, pathIndex) ||
				(pathIndex < pathParts.length && match(patternIndex, pathIndex + 1))
			)
		}
		const pathPart = pathParts[pathIndex]
		return (
			pathPart !== undefined &&
			segmentMatches(patternPart, pathPart) &&
			match(patternIndex + 1, pathIndex + 1)
		)
	}
	return match(0, 0)
}

function segmentMatches(pattern: string, value: string): boolean {
	if (pattern === '*') return true
	const source = pattern
		.split('*')
		.map((part) => part.replace(/[\\^$+?.()|[\]{}]/g, '\\$&'))
		.join('.*')
	return new RegExp(`^${source}$`).test(value)
}
