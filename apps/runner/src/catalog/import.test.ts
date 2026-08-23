import { deflateRawSync } from 'node:zlib'
import type { ReleaseManifest } from '@justfiles/app/appstore/protocol'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { importRelease } from './import'
import type { AppRecord, Resolved } from './refresh-app'
import { entries, inflate } from './zip'

// A ZIP writer, because every interesting case here is an archive nobody would
// produce on purpose: a declared size that lies, a symlink, a name that climbs
// out of its own directory.

interface Source {
	name: string
	body?: string | Uint8Array
	/** 0 stored, 8 deflate. */
	method?: number
	/** Unix mode << 16 in the external attributes; 0xa000 is a symlink. */
	mode?: number
	/** What the archive CLAIMS the entry inflates to, when that is a lie. */
	declared?: number
}

const bytes = (body: string | Uint8Array) =>
	typeof body === 'string' ? new TextEncoder().encode(body) : body

function zip(sources: Source[]): Uint8Array {
	const parts: Uint8Array[] = []
	const central: Uint8Array[] = []
	let offset = 0

	const rec = (fields: [number, number][], ...tail: Uint8Array[]) => {
		const head = new Uint8Array(fields.reduce((n, [, width]) => n + width, 0))
		const view = new DataView(head.buffer)
		let at = 0
		for (const [value, width] of fields) {
			if (width === 2) view.setUint16(at, value, true)
			else view.setUint32(at, value, true)
			at += width
		}
		const size = head.length + tail.reduce((n, t) => n + t.length, 0)
		const out = new Uint8Array(size)
		out.set(head)
		let p = head.length
		for (const t of tail) {
			out.set(t, p)
			p += t.length
		}
		return out
	}

	for (const source of sources) {
		const name = new TextEncoder().encode(source.name)
		const raw = bytes(source.body ?? '')
		const method = source.method ?? 8
		const payload = method === 8 ? new Uint8Array(deflateRawSync(raw)) : raw
		const declared = source.declared ?? raw.length

		const local = rec(
			[
				[0x04034b50, 4],
				[20, 2],
				[0, 2],
				[method, 2],
				[0, 2],
				[0, 2],
				[0, 4],
				[payload.length, 4],
				[declared, 4],
				[name.length, 2],
				[0, 2]
			],
			name,
			payload
		)
		central.push(
			rec(
				[
					[0x02014b50, 4],
					[20, 2],
					[20, 2],
					[0, 2],
					[method, 2],
					[0, 2],
					[0, 2],
					[0, 4],
					[payload.length, 4],
					[declared, 4],
					[name.length, 2],
					[0, 2],
					[0, 2],
					[0, 2],
					[0, 2],
					[(source.mode ?? 0o100644) << 16, 4],
					[offset, 4]
				],
				name
			)
		)
		parts.push(local)
		offset += local.length
	}

	const directory = central.reduce((n, c) => n + c.length, 0)
	parts.push(
		...central,
		rec([
			[0x06054b50, 4],
			[0, 2],
			[0, 2],
			[sources.length, 2],
			[sources.length, 2],
			[directory, 4],
			[offset, 4],
			[0, 2]
		])
	)

	const total = parts.reduce((n, p) => n + p.length, 0)
	const out = new Uint8Array(total)
	let p = 0
	for (const part of parts) {
		out.set(part, p)
		p += part.length
	}
	return out
}

const MANIFEST = JSON.stringify({
	id: 'justfiles.draw',
	name: 'Draw',
	version: '0.0.0',
	app: 'app.js',
	gui: 'gui.js'
})

const bundle = (extra: Source[] = []) =>
	zip([
		{ name: 'manifest.json', body: MANIFEST },
		{ name: 'app.js', body: 'export const reduce = () => {}' },
		{ name: 'gui.js', body: 'export const mount = () => {}' },
		...extra
	])

// An in-memory R2, and a fetch that serves one archive.

function store() {
	const objects = new Map<string, Uint8Array>()
	return {
		objects,
		STORE: {
			get: async (key: string) => {
				const value = objects.get(key)
				if (!value) return null
				return {
					json: async () => JSON.parse(new TextDecoder().decode(value)),
					body: value
				}
			},
			put: async (key: string, value: Uint8Array | string) => {
				objects.set(key, bytes(typeof value === 'string' ? value : value))
			}
		},
		GITHUB_TOKEN: 'test'
	} as unknown as CloudflareBindings & { objects: Map<string, Uint8Array> }
}

const serve = (archive: Uint8Array) =>
	vi.stubGlobal('fetch', async () => new Response(archive as unknown as BodyInit, { status: 200 }))

const RESOLVED: Resolved = {
	version: '1.0.0',
	rung: 1,
	ref: 'v1.0.0',
	commit: 'a3f9c21',
	assetId: 1
}

const RECORD: AppRecord = {
	repoNodeId: 'R_1',
	defaultBranch: 'main',
	current: null,
	etags: {},
	checkedAt: 0,
	error: null,
	releases: {}
}

const seed = (env: ReturnType<typeof store>, record: Partial<AppRecord> = {}) =>
	env.objects.set(
		'apps/justfiles.draw/record.json',
		bytes(JSON.stringify({ ...RECORD, ...record }))
	)

const read = (env: ReturnType<typeof store>, key: string) =>
	JSON.parse(new TextDecoder().decode(env.objects.get(key) as Uint8Array))

const recordOf = (env: ReturnType<typeof store>): AppRecord =>
	read(env, 'apps/justfiles.draw/record.json')

const manifestOf = (env: ReturnType<typeof store>): ReleaseManifest =>
	read(env, 'apps/justfiles.draw/1.0.0/manifest.json')

const run = async (archive: Uint8Array, record: Partial<AppRecord> = {}) => {
	const env = store()
	seed(env, record)
	serve(archive)
	await importRelease(env, 'justfiles.draw', 'justfiles/app-draw', RESOLVED)
	return env
}

beforeEach(() => vi.unstubAllGlobals())

describe('zip', () => {
	it('reads deflated and stored entries alike', async () => {
		const archive = zip([
			{ name: 'a.txt', body: 'deflated', method: 8 },
			{ name: 'b.txt', body: 'stored', method: 0 }
		])
		const found = entries(archive)
		expect(found.map((e) => e.name)).toEqual(['a.txt', 'b.txt'])
		const read = async (i: number) =>
			new TextDecoder().decode(await inflate(archive, found[i] as never, 1024))
		expect(await read(0)).toBe('deflated')
		expect(await read(1)).toBe('stored')
	})

	it('caps on bytes produced, not on the size the archive declares', async () => {
		// The bomb: 4 MB of zeros compresses to a few KB and claims to be 10 bytes.
		const archive = zip([{ name: 'bomb', body: new Uint8Array(4 * 1024 * 1024), declared: 10 }])
		const [entry] = entries(archive)
		expect(entry?.size).toBe(10)
		await expect(inflate(archive, entry as never, 64 * 1024)).rejects.toThrow('over 65536 bytes')
	})

	it('refuses a stored entry over the cap, where there is no inflate to stop', async () => {
		const archive = zip([{ name: 'big', body: new Uint8Array(4096), method: 0 }])
		await expect(inflate(archive, entries(archive)[0] as never, 100)).rejects.toThrow('over 100')
	})

	it('refuses an unknown compression method', async () => {
		const archive = zip([{ name: 'lzma', body: 'x', method: 14 }])
		await expect(inflate(archive, entries(archive)[0] as never, 1024)).rejects.toThrow('method 14')
	})

	it('refuses something that is not an archive', () => {
		expect(() => entries(new TextEncoder().encode('not a zip at all'))).toThrow('not an archive')
	})
})

describe('importRelease', () => {
	it('extracts a bundle, writes the canonical manifest, and publishes it', async () => {
		const env = await run(bundle())
		const keys = [...env.objects.keys()].sort()

		expect(keys).toContain('apps/justfiles.draw/1.0.0/files/gui.js')
		expect(keys).toContain('apps/justfiles.draw/1.0.0/bundle.zip')
		// Control metadata, not payload: its bytes stay in the archive.
		expect(keys).not.toContain('apps/justfiles.draw/1.0.0/files/manifest.json')

		const manifest = manifestOf(env)
		expect(manifest.schema).toBe('justapps/manifest/v1')
		// The resolved version wins over the authored one, and every payload file is
		// pinned with its actual size — the reducer included.
		expect(manifest.version).toBe('1.0.0')
		expect(manifest.files.map((file) => file.path)).toEqual(['app.js', 'gui.js'])
		expect(manifest.files[1]?.hash).toMatch(/^sha256-[0-9a-f]{64}$/)
		expect(manifest.files[1]?.size).toBe('export const mount = () => {}'.length)
		expect(manifest.hash).toMatch(/^[0-9a-f]{64}$/)
		// Derived by the client from where the manifest was served, never stored.
		expect(manifest).not.toHaveProperty('baseUrl')

		const record = recordOf(env)
		expect(record.current).toBe('1.0.0')
		expect(record.releases['1.0.0']?.state).toBe('ready')
		// Provenance of the archive, and no second copy of the manifest's hash.
		expect(record.releases['1.0.0']?.bundle.digest).toMatch(/^sha256-[0-9a-f]{64}$/)
		expect(record.releases['1.0.0']?.bundle.unpacked).toBeGreaterThan(0)
		expect(record.releases['1.0.0']).not.toHaveProperty('hash')
		expect(record.error).toBeNull()
	})

	it('drops authored fields that are ours to decide', async () => {
		const env = await run(
			zip([
				{
					name: 'manifest.json',
					body: JSON.stringify({
						id: 'someone.else',
						name: 'Draw',
						app: 'app.js',
						baseUrl: 'https://evil.example/',
						hash: 'nonsense',
						files: { 'gui.js': 'sha256-nonsense' },
						include: ['whatever']
					})
				},
				{ name: 'app.js', body: 'x' }
			])
		)
		const manifest = manifestOf(env)
		expect(manifest.id).toBe('justfiles.draw')
		expect(manifest.hash).not.toBe('nonsense')
		expect(manifest.files).toEqual([expect.objectContaining({ path: 'app.js' })])
		expect(manifest).not.toHaveProperty('include')
	})

	it('finds the bundle under a zipball wrapper and a dist/ root', async () => {
		const env = await run(
			zip([
				{ name: 'justfiles-app-draw-a3f9c21/README.md', body: '# draw' },
				{ name: 'justfiles-app-draw-a3f9c21/dist/manifest.json', body: MANIFEST },
				{ name: 'justfiles-app-draw-a3f9c21/dist/app.js', body: 'x' },
				{ name: 'justfiles-app-draw-a3f9c21/dist/gui.js', body: 'y' }
			])
		)
		expect([...env.objects.keys()]).toContain('apps/justfiles.draw/1.0.0/files/gui.js')
		// Outside the bundle root, so never rehosted.
		expect([...env.objects.keys()]).not.toContain('apps/justfiles.draw/1.0.0/files/README.md')
	})

	// Every one of these records the failure and writes nothing reachable: the
	// release never lands in record.json, so the app keeps serving what it had.
	const hostile: [string, Uint8Array, string][] = [
		['path traversal', bundle([{ name: '../../escape.js', body: 'x' }]), 'invalid app bundle path'],
		['an absolute path', bundle([{ name: '/etc/passwd', body: 'x' }]), 'invalid app bundle path'],
		['a symlink', bundle([{ name: 'link.js', body: '../../x', mode: 0o120777 }]), 'symlink'],
		['a windows separator', bundle([{ name: 'a\\..\\b.js', body: 'x' }]), 'backslash'],
		['a committed secret', bundle([{ name: '.env', body: 'TOKEN=1' }]), 'refusing to rehost'],
		['a private key', bundle([{ name: 'keys/server.pem', body: 'x' }]), 'refusing to rehost'],
		['a case collision', bundle([{ name: 'GUI.js', body: 'x' }]), 'duplicate'],
		['no manifest', zip([{ name: 'gui.js', body: 'x' }]), 'no manifest.json'],
		[
			'a manifest naming a missing reducer',
			zip([{ name: 'manifest.json', body: MANIFEST }]),
			'which is not here'
		]
	]

	for (const [what, archive, message] of hostile) {
		it(`refuses ${what}`, async () => {
			const env = await run(archive)
			const record = recordOf(env)
			expect(record.error).toContain(message)
			expect(record.current).toBeNull()
			expect(record.releases['1.0.0']).toBeUndefined()
			expect([...env.objects.keys()]).not.toContain('apps/justfiles.draw/1.0.0/manifest.json')
		})
	}

	it('never rewrites a version it already holds', async () => {
		const env = await run(bundle(), {
			releases: {
				'1.0.0': {
					...RESOLVED,
					bundle: { digest: 'd', size: 1, unpacked: 1 },
					state: 'ready',
					at: 0
				}
			}
		})
		expect([...env.objects.keys()]).not.toContain('apps/justfiles.draw/1.0.0/manifest.json')
	})
})
