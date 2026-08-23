import { init, parse } from 'es-module-lexer'
import { sdkRuntimeSpecs } from '../../runtime-specs.ts'
import type { Diagnostic, TypePaths, TypesBundle } from './toolchain.ts'

export type ImportMap = Record<string, string>

export interface CachedImport {
	url: string
	text: string
	types?: string
}

export interface ImportCache {
	get(url: string): Promise<CachedImport | undefined>
	put(url: string, value: CachedImport): Promise<void>
}

export interface ImportLock {
	schema: 'justfiles.devkit-imports.v1'
	imports: Record<string, { source: string; url: string; types?: string }>
	files: Record<string, { hash: string; size: number }>
}

export interface ResolvedImports {
	runtime: Record<string, string>
	types: TypesBundle
	paths: TypePaths
	lock?: ImportLock
	diagnostics: Diagnostic[]
}

export interface ImportLimits {
	depth: number
	files: number
	fileBytes: number
	totalBytes: number
	timeoutMs: number
}

interface ResolveOptions {
	cache: ImportCache
	fetch?: typeof fetch
	lock?: ImportLock
	limits?: Partial<ImportLimits>
}

const LIMITS: ImportLimits = {
	depth: 20,
	files: 100,
	fileBytes: 2 * 1024 * 1024,
	totalBytes: 20 * 1024 * 1024,
	timeoutMs: 10_000
}
const LOCK_SCHEMA = 'justfiles.devkit-imports.v1'
const encoder = new TextEncoder()

export function validateImportMap(value: unknown): ImportMap {
	if (value === undefined) return {}
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('project.json "imports" must be an object')
	}
	const imports: ImportMap = {}
	for (const [specifier, source] of Object.entries(value)) {
		if (!isBareSpecifier(specifier)) {
			throw new Error(`project.json import key must be a bare specifier: ${specifier}`)
		}
		if (isSdkSpecifier(specifier)) {
			throw new Error(`project.json cannot replace platform import: ${specifier}`)
		}
		if (typeof source !== 'string' || !isPinnedEsmUrl(source)) {
			throw new Error(`project.json import must use a pinned https://esm.sh URL: ${specifier}`)
		}
		imports[specifier] = source
	}
	return imports
}

export function parseImportLock(value: unknown): ImportLock {
	if (!value || typeof value !== 'object') throw new Error('devkit-lock.json is invalid')
	const lock = value as Partial<ImportLock>
	if (lock.schema !== LOCK_SCHEMA || !isRecord(lock.imports) || !isRecord(lock.files)) {
		throw new Error('devkit-lock.json is invalid')
	}
	for (const entry of Object.values(lock.imports)) {
		if (
			!isRecord(entry) ||
			typeof entry.source !== 'string' ||
			typeof entry.url !== 'string' ||
			(entry.types !== undefined && typeof entry.types !== 'string')
		) {
			throw new Error('devkit-lock.json is invalid')
		}
	}
	for (const file of Object.values(lock.files)) {
		if (!isRecord(file) || typeof file.hash !== 'string' || typeof file.size !== 'number') {
			throw new Error('devkit-lock.json is invalid')
		}
	}
	return lock as ImportLock
}

export async function resolveImports(
	imports: ImportMap,
	options: ResolveOptions
): Promise<ResolvedImports> {
	const result: ResolvedImports = {
		runtime: {},
		types: {},
		paths: {},
		diagnostics: []
	}
	try {
		const validatedImports = validateImportMap(imports)
		validateLockImports(validatedImports, options.lock)
		const resolver = new Resolver(validatedImports, options)
		const lockImports: ImportLock['imports'] = {}
		const entries: Record<string, string> = {}
		for (const [specifier, source] of Object.entries(validatedImports)) {
			const module = await resolver.visit(source, 'module', 0)
			entries[specifier] = module.url
			if (module.types) {
				const types = resolveUrl(module.types, module.url)
				resolver.setTypeEntry(specifier, types)
				result.paths[specifier] = [types]
			}
			lockImports[specifier] = {
				source,
				url: module.url,
				...(result.paths[specifier] ? { types: result.paths[specifier][0] } : {})
			}
		}
		for (const [specifier, targets] of Object.entries(result.paths)) {
			const types = targets[0]
			const lockEntry = lockImports[specifier]
			if (!types || !lockEntry) throw new Error(`Missing type entry: ${specifier}`)
			const finalUrl = (await resolver.visit(types, 'type', 0)).url
			result.paths[specifier] = [finalUrl]
			lockEntry.types = finalUrl
		}
		await resolver.drain()
		result.runtime = { ...resolver.modules }
		for (const [specifier, url] of Object.entries(entries)) {
			const source = resolver.modules[url]
			if (source === undefined) throw new Error(`Missing module entry: ${specifier}`)
			result.runtime[specifier] = source
		}
		result.types = resolver.types
		result.lock = { schema: LOCK_SCHEMA, imports: lockImports, files: resolver.files }
		validateCompleteLock(result.lock, options.lock)
	} catch (error) {
		result.diagnostics.push(diagnostic(error))
	}
	return result
}

class Resolver {
	readonly modules: Record<string, string> = {}
	readonly types: Record<string, string> = {}
	readonly files: ImportLock['files'] = {}
	private readonly imports: ImportMap
	private readonly options: ResolveOptions
	private readonly limits: ImportLimits
	private readonly queue: { url: string; kind: 'module' | 'type'; depth: number }[] = []
	private readonly requested = new Set<string>()
	private readonly versions = new Map<string, string>()
	private readonly typeImports: ImportMap = {}
	private totalBytes = 0

	constructor(imports: ImportMap, options: ResolveOptions) {
		this.imports = imports
		this.options = options
		this.limits = { ...LIMITS, ...options.limits }
	}

	setTypeEntry(specifier: string, url: string): void {
		this.typeImports[specifier] = url
	}

	async visit(url: string, kind: 'module' | 'type', depth: number): Promise<CachedImport> {
		if (depth > this.limits.depth) throw new ImportError('IMPORT_DEPTH', 'Import graph is too deep')
		assertAllowedUrl(url)
		const value = await this.load(url)
		const output = kind === 'module' ? this.modules : this.types
		if (!(value.url in output)) {
			output[value.url] = value.text
			if (kind === 'type') this.trackVersion(value.url)
			const refs = kind === 'module' ? await moduleRefs(value.text) : typeRefs(value.text)
			for (const ref of refs) {
				const next = this.resolveRef(ref, value.url, kind)
				this.queue.push({ url: next, kind, depth: depth + 1 })
			}
		}
		return value
	}

	async drain(): Promise<void> {
		for (const item of this.queue) {
			if (this.requested.has(`${item.kind}:${item.url}`)) continue
			this.requested.add(`${item.kind}:${item.url}`)
			await this.visit(item.url, item.kind, item.depth)
		}
	}

	private async load(requestedUrl: string): Promise<CachedImport> {
		const cached = await this.options.cache.get(requestedUrl)
		const value = cached ?? (await this.download(requestedUrl))
		assertAllowedUrl(value.url)
		const bytes = encoder.encode(value.text).byteLength
		if (bytes > this.limits.fileBytes) {
			throw new ImportError('IMPORT_FILE_SIZE', `Import is too large: ${value.url}`)
		}
		if (!(value.url in this.files)) {
			if (Object.keys(this.files).length >= this.limits.files) {
				throw new ImportError('IMPORT_FILE_COUNT', 'Import graph has too many files')
			}
			this.totalBytes += bytes
			if (this.totalBytes > this.limits.totalBytes) {
				throw new ImportError('IMPORT_TOTAL_SIZE', 'Import graph is too large')
			}
			const file = { hash: await hash(value.text), size: bytes }
			const locked = this.options.lock?.files[value.url]
			if (locked && (locked.hash !== file.hash || locked.size !== file.size)) {
				throw new ImportError('IMPORT_LOCK_MISMATCH', `Import changed: ${value.url}`)
			}
			this.files[value.url] = file
		}
		if (!cached) {
			await this.options.cache.put(requestedUrl, value)
			if (value.url !== requestedUrl) await this.options.cache.put(value.url, value)
		}
		return value
	}

	private async download(url: string): Promise<CachedImport> {
		let response: Response
		try {
			response = await (this.options.fetch ?? fetch)(url, {
				credentials: 'omit',
				// Browsers hide manual redirect targets. Fetch follow mode has a hard limit of 20.
				redirect: 'follow',
				signal: AbortSignal.timeout(this.limits.timeoutMs)
			})
		} catch (error) {
			throw new ImportError('IMPORT_FETCH', `Cannot fetch ${url}: ${message(error)}`)
		}
		if (!response.ok) {
			throw new ImportError('IMPORT_FETCH', `Cannot fetch ${url}: HTTP ${response.status}`)
		}
		const length = Number(response.headers.get('content-length'))
		if (length > this.limits.fileBytes) {
			throw new ImportError('IMPORT_FILE_SIZE', `Import is too large: ${url}`)
		}
		const types = response.headers.get('x-typescript-types')
		const value = {
			url: response.url || url,
			text: await response.text(),
			...(types ? { types } : {})
		}
		return value
	}

	private resolveRef(ref: string, importer: string, kind: 'module' | 'type'): string {
		if (ref.startsWith('node:') || ref.startsWith('/node/')) {
			throw new ImportError('IMPORT_NODE', `Node import is not supported: ${ref}`)
		}
		if (isBareSpecifier(ref)) {
			const source = kind === 'type' ? this.typeImports[ref] : this.imports[ref]
			if (!source) throw new ImportError('IMPORT_BARE', `Unmapped import: ${ref}`)
			return source
		}
		return resolveUrl(ref, importer)
	}

	private trackVersion(url: string): void {
		const match = new URL(url).pathname.match(/^\/((?:@[^/]+\/)?[^/@]+)@([^/]+)/)
		if (!match) return
		const [, name, version] = match
		if (!name || !version) return
		const prior = this.versions.get(name)
		if (prior && prior !== version) {
			throw new ImportError(
				'IMPORT_VERSION_CONFLICT',
				`Import graph has two versions of ${name}: ${prior} and ${version}`
			)
		}
		this.versions.set(name, version)
	}
}

async function moduleRefs(source: string): Promise<string[]> {
	await init
	const [imports] = parse(source)
	const refs: string[] = []
	for (const entry of imports) {
		if (entry.d >= 0 && entry.n === undefined) {
			throw new ImportError('IMPORT_DYNAMIC', 'Dynamic import must use a string literal')
		}
		if (entry.n !== undefined) refs.push(entry.n)
	}
	return refs
}

function typeRefs(source: string): string[] {
	const refs: string[] = []
	for (const line of source.split('\n')) {
		const text = line.trim()
		if (!text || text.startsWith('//') || text.startsWith('*') || text.startsWith('/*')) continue
		for (const match of text.matchAll(/\b(?:from|require\(|import\s*\(?)\s*["']([^"']+)["']/g)) {
			if (match[1]) refs.push(match[1])
		}
	}
	for (const match of source.matchAll(
		/^\s*\/\/\/\s*<reference\s+(?:path|types)=["']([^"']+)["']/gm
	)) {
		if (match[1]) refs.push(match[1])
	}
	return refs
}

function validateLockImports(imports: ImportMap, lock?: ImportLock): void {
	if (!lock) return
	const keys = Object.keys(imports).sort()
	if (JSON.stringify(keys) !== JSON.stringify(Object.keys(lock.imports).sort())) {
		throw new ImportError('IMPORT_LOCK_MISMATCH', 'Import map does not match devkit-lock.json')
	}
	for (const [specifier, source] of Object.entries(imports)) {
		if (lock.imports[specifier]?.source !== source) {
			throw new ImportError('IMPORT_LOCK_MISMATCH', `Locked import changed: ${specifier}`)
		}
	}
}

function validateCompleteLock(actual: ImportLock, expected?: ImportLock): void {
	if (!expected) return
	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new ImportError('IMPORT_LOCK_MISMATCH', 'Resolved imports do not match devkit-lock.json')
	}
}

function assertAllowedUrl(value: string): void {
	let url: URL
	try {
		url = new URL(value)
	} catch {
		throw new ImportError('IMPORT_URL', `Invalid import URL: ${value}`)
	}
	if (url.origin !== 'https://esm.sh' || url.hash || url.username || url.password) {
		throw new ImportError('IMPORT_URL', `Import left https://esm.sh: ${value}`)
	}
	if (url.pathname.startsWith('/node/')) {
		throw new ImportError('IMPORT_NODE', `Node import is not supported: ${value}`)
	}
}

function resolveUrl(ref: string, importer: string): string {
	let url: string
	try {
		url = new URL(ref, importer).href
	} catch {
		throw new ImportError('IMPORT_URL', `Invalid import URL: ${ref}`)
	}
	assertAllowedUrl(url)
	return url
}

function isPinnedEsmUrl(value: string): boolean {
	try {
		const url = new URL(value)
		return (
			url.origin === 'https://esm.sh' &&
			!url.hash &&
			!url.username &&
			!url.password &&
			/^\/(?:@[^/]+\/)?[^/@]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\/[^?]*)?$/.test(url.pathname)
		)
	} catch {
		return false
	}
}

function isBareSpecifier(value: string): boolean {
	return !!value && !value.startsWith('.') && !value.startsWith('/') && !value.includes('://')
}

function isSdkSpecifier(value: string): boolean {
	return sdkRuntimeSpecs.includes(value) || value.startsWith('@justfiles/app/')
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value)
}

async function hash(text: string): Promise<string> {
	const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(text))
	return `sha256-${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

function diagnostic(error: unknown): Diagnostic {
	return {
		file: '',
		range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
		severity: 'error',
		source: 'imports',
		code: error instanceof ImportError ? error.code : 'IMPORT_ERROR',
		message: message(error)
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

class ImportError extends Error {
	readonly code: string

	constructor(code: string, message: string) {
		super(message)
		this.code = code
	}
}
