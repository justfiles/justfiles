import { sdkRuntimeSpecs } from '../../runtime-specs.ts'
import type { Diagnostic } from './toolchain.ts'

export type ImportMap = Record<string, string>

export interface CachedImport {
	url: string
	text: string
}

export interface ImportCache {
	get(url: string): Promise<CachedImport | undefined>
	put(url: string, value: CachedImport): Promise<void>
}

export interface ImportLock {
	version: 1
	redirects: Record<string, string>
	remote: Record<string, string>
}

export interface ImportLimits {
	depth: number
	files: number
	fileBytes: number
	totalBytes: number
	timeoutMs: number
}

export interface ResolvedImports {
	code: Record<string, string>
	declarations: Record<string, string>
	limits: Readonly<ImportLimits>
	load(url: string): Promise<CachedImport>
	resolve(specifier: string, importer: string, kind: 'code' | 'types'): string
	lock(): ImportLock
	diagnostics: Diagnostic[]
}

interface ResolveOptions {
	cache: ImportCache
	fetch?: typeof fetch
	lock?: ImportLock
	frozen?: boolean
	limits?: Partial<ImportLimits>
}

const LIMITS: ImportLimits = {
	depth: 20,
	files: 100,
	fileBytes: 2 * 1024 * 1024,
	totalBytes: 20 * 1024 * 1024,
	timeoutMs: 10_000
}
const encoder = new TextEncoder()

export function validateImportMap(value: unknown): ImportMap {
	if (value === undefined) return {}
	if (!isRecord(value)) throw new Error('project.json "imports" must be an object')
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
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		!isRecord(value.redirects) ||
		!isRecord(value.remote)
	) {
		throw new Error('devkit-lock.json is invalid')
	}
	if (
		!Object.values(value.redirects).every((url) => typeof url === 'string') ||
		!Object.values(value.remote).every(
			(hash) => typeof hash === 'string' && /^sha256-[0-9a-f]{64}$/.test(hash)
		)
	) {
		throw new Error('devkit-lock.json is invalid')
	}
	return value as unknown as ImportLock
}

// Resolve only package entry metadata here. esbuild and TypeScript follow their
// own graphs through `load` and `resolve`, so this module does not parse either
// language or keep a second module graph.
export async function resolveImports(
	value: ImportMap,
	options: ResolveOptions
): Promise<ResolvedImports> {
	const code: Record<string, string> = {}
	const declarations: Record<string, string> = {}
	const limits = { ...LIMITS, ...options.limits }
	const store = new Store(options, limits)
	const result: ResolvedImports = {
		code,
		declarations,
		limits,
		load: (url) => store.load(url),
		resolve: (specifier, importer, kind) => {
			if (specifier.startsWith('node:') || specifier.startsWith('/node/')) {
				throw new ImportError('IMPORT_NODE', `Node import is not supported: ${specifier}`)
			}
			if (isBareSpecifier(specifier)) {
				const url = kind === 'code' ? code[specifier] : declarations[specifier]
				if (!url) throw new ImportError('IMPORT_BARE', `Unmapped import: ${specifier}`)
				return url
			}
			return resolveUrl(specifier, importer)
		},
		lock: () => store.lock(),
		diagnostics: []
	}
	try {
		for (const [specifier, source] of Object.entries(validateImportMap(value))) {
			const metadata = await store.load(metadataUrl(source))
			const entry = parseMetadata(metadata)
			code[specifier] = resolveUrl(entry.module, metadata.url)
			if (entry.dts) declarations[specifier] = resolveUrl(entry.dts, metadata.url)
		}
	} catch (error) {
		result.diagnostics.push(importDiagnostic(error))
	}
	return result
}

class Store {
	private readonly options: ResolveOptions
	private readonly limits: ImportLimits
	private readonly redirects: Record<string, string> = {}
	private readonly remote: Record<string, string> = {}
	private readonly loaded = new Map<string, CachedImport>()
	private readonly pending = new Map<string, Promise<CachedImport>>()
	private totalBytes = 0

	constructor(options: ResolveOptions, limits: ImportLimits) {
		this.options = options
		this.limits = limits
		Object.assign(this.redirects, options.lock?.redirects)
		Object.assign(this.remote, options.lock?.remote)
	}

	load(url: string): Promise<CachedImport> {
		assertAllowedUrl(url)
		const loaded = this.loaded.get(url)
		if (loaded) return Promise.resolve(loaded)
		const active = this.pending.get(url)
		if (active) return active
		const task = this.loadOne(url).finally(() => this.pending.delete(url))
		this.pending.set(url, task)
		return task
	}

	lock(): ImportLock {
		return { version: 1, redirects: { ...this.redirects }, remote: { ...this.remote } }
	}

	private async loadOne(requestedUrl: string): Promise<CachedImport> {
		const cached = await this.options.cache.get(requestedUrl)
		const value = cached ?? (await this.download(requestedUrl))
		assertAllowedUrl(value.url)
		const bytes = encoder.encode(value.text).byteLength
		if (bytes > this.limits.fileBytes) {
			throw new ImportError('IMPORT_FILE_SIZE', `Import is too large: ${value.url}`)
		}
		const digest = await hash(value.text)
		this.verify(requestedUrl, value.url, digest)
		if (requestedUrl !== value.url) this.redirects[requestedUrl] = value.url
		const prior = this.remote[value.url]
		if (prior && prior !== digest) {
			throw new ImportError('IMPORT_LOCK_MISMATCH', `Import changed: ${value.url}`)
		}
		if (!prior) {
			if (Object.keys(this.remote).length >= this.limits.files) {
				throw new ImportError('IMPORT_FILE_COUNT', 'Import graph has too many files')
			}
			this.totalBytes += bytes
			if (this.totalBytes > this.limits.totalBytes) {
				throw new ImportError('IMPORT_TOTAL_SIZE', 'Import graph is too large')
			}
			this.remote[value.url] = digest
		}
		if (!cached) {
			await this.options.cache.put(requestedUrl, value)
			if (requestedUrl !== value.url) await this.options.cache.put(value.url, value)
		}
		this.loaded.set(requestedUrl, value)
		this.loaded.set(value.url, value)
		return value
	}

	private verify(requestedUrl: string, finalUrl: string, digest: string): void {
		const lock = this.options.lock
		if (!lock) return
		const frozen = this.options.frozen ?? true
		const redirected = lock.redirects[requestedUrl]
		const requestedDigest = lock.remote[requestedUrl]
		const expectedDigest = lock.remote[finalUrl]
		if (!frozen && redirected === undefined && requestedDigest === undefined) {
			if (expectedDigest === undefined || expectedDigest === digest) return
		}
		const expectedUrl = redirected ?? requestedUrl
		if (
			expectedUrl !== finalUrl ||
			(expectedDigest !== undefined && expectedDigest !== digest) ||
			expectedDigest === undefined
		) {
			throw new ImportError(
				'IMPORT_LOCK_MISMATCH',
				`Import does not match devkit-lock.json: ${requestedUrl}`
			)
		}
	}

	private async download(url: string): Promise<CachedImport> {
		let response: Response
		try {
			response = await (this.options.fetch ?? fetch)(url, {
				credentials: 'omit',
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
		return { url: response.url || url, text: await response.text() }
	}
}

function metadataUrl(source: string): string {
	return `${source}${source.includes('?') ? '&' : '?'}meta`
}

function parseMetadata(file: CachedImport): { module: string; dts?: string } {
	let value: unknown
	try {
		value = JSON.parse(file.text)
	} catch {
		throw new ImportError('IMPORT_METADATA', `Invalid package metadata: ${file.url}`)
	}
	if (!isRecord(value) || typeof value.module !== 'string') {
		throw new ImportError('IMPORT_METADATA', `Invalid package metadata: ${file.url}`)
	}
	if (value.dts !== undefined && typeof value.dts !== 'string') {
		throw new ImportError('IMPORT_METADATA', `Invalid package metadata: ${file.url}`)
	}
	return { module: value.module, ...(value.dts ? { dts: value.dts } : {}) }
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

export function importDiagnostic(error: unknown): Diagnostic {
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
