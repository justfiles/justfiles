import { deflateRawSync } from 'node:zlib'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { importRelease } from './import'
import type { Info, Resolved } from './refresh-app'
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

const INFO: Info = {
	repoNodeId: 'R_1',
	defaultBranch: 'main',
	current: null,
	etags: {},
	checkedAt: 0,
	error: null,
	releases: {}
}

const seed = (env: ReturnType<typeof store>, info: Partial<Info> = {}) =>
	env.objects.set('apps/justfiles.draw/info.json', bytes(JSON.stringify({ ...INFO, ...info })))

const infoOf = (env: ReturnType<typeof store>): Info =>
	JSON.parse(
		new TextDecoder().decode(env.objects.get('apps/justfiles.draw/info.json') as Uint8Array)
	)

const run = async (archive: Uint8Array, info: Partial<Info> = {}) => {
	const env = store()
	seed(env, info)
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
	it('extracts a bundle, writes the spec, and publishes it', async () => {
		const env = await run(bundle())
		const keys = [...env.objects.keys()].sort()

		expect(keys).toContain('apps/justfiles.draw/1.0.0/files/gui.js')
		expect(keys).toContain('apps/justfiles.draw/1.0.0/bundle.zip')

		const spec = JSON.parse(
			new TextDecoder().decode(env.objects.get('apps/justfiles.draw/1.0.0/spec.json') as Uint8Array)
		)
		// The resolved version wins over the manifest's, and the reducer is covered
		// by `hash` but deliberately absent from the mounted `files`.
		expect(spec.version).toBe('1.0.0')
		expect(Object.keys(spec.files).sort()).toEqual(['gui.js', 'manifest.json'])
		expect(spec.files['gui.js']).toMatch(/^sha256-[0-9a-f]{64}$/)
		expect(spec.hash).toMatch(/^[0-9a-f]{64}$/)
		// Injected at serve time, never stored — see kb/registry.md.
		expect(spec.baseUrl).toBeUndefined()

		const info = infoOf(env)
		expect(info.current).toBe('1.0.0')
		expect(info.releases['1.0.0']?.state).toBe('ready')
		expect(info.error).toBeNull()
	})

	// The store's half of the same release. `spec.json` is an `AppManifest` and
	// pins only what mounts; a device downloads the reducer into its volume and
	// verifies it there, so the digest `spec.json` omits has to live somewhere.
	it('records every file, the reducer included, with its size', async () => {
		const env = await run(bundle())
		const files = JSON.parse(
			new TextDecoder().decode(
				env.objects.get('apps/justfiles.draw/1.0.0/files.json') as Uint8Array
			)
		)
		expect(files.map((file: { path: string }) => file.path)).toEqual([
			'app.js',
			'gui.js',
			'manifest.json'
		])
		expect(files[0]).toEqual({
			path: 'app.js',
			hash: expect.stringMatching(/^sha256-[0-9a-f]{64}$/),
			size: 'export const reduce = () => {}'.length
		})
	})

	// `info.json` is the last write, and nothing reachable through it may be
	// missing by the time it lands — the same rule `spec.json` already obeys.
	it('writes the file list before the record that publishes it', async () => {
		const env = store()
		seed(env)
		// The map preserves insertion order, but `seed` already put `info.json` in
		// it, so the order has to be observed rather than read off the keys.
		const written: string[] = []
		const put = env.STORE.put.bind(env.STORE)
		env.STORE.put = ((key: string, value: never) => {
			written.push(key)
			return put(key, value)
		}) as typeof env.STORE.put
		serve(bundle())
		await importRelease(env, 'justfiles.draw', 'justfiles/app-draw', RESOLVED)

		expect(written.indexOf('apps/justfiles.draw/1.0.0/files.json')).toBeLessThan(
			written.indexOf('apps/justfiles.draw/1.0.0/spec.json')
		)
		expect(written.indexOf('apps/justfiles.draw/1.0.0/spec.json')).toBeLessThan(
			written.indexOf('apps/justfiles.draw/info.json')
		)
	})

	it('serves the id we were asked for, not the one the manifest claims', async () => {
		const env = await run(
			zip([
				{ name: 'manifest.json', body: MANIFEST.replace('justfiles.draw', 'someone.else') },
				{ name: 'app.js', body: 'x' }
			])
		)
		const spec = JSON.parse(
			new TextDecoder().decode(env.objects.get('apps/justfiles.draw/1.0.0/spec.json') as Uint8Array)
		)
		expect(spec.id).toBe('justfiles.draw')
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
	// release never lands in info.json, so the app keeps serving what it had.
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
			const info = infoOf(env)
			expect(info.error).toContain(message)
			expect(info.current).toBeNull()
			expect(info.releases['1.0.0']).toBeUndefined()
			expect([...env.objects.keys()]).not.toContain('apps/justfiles.draw/1.0.0/spec.json')
		})
	}

	it('never rewrites a version it already holds', async () => {
		const env = await run(bundle(), {
			releases: {
				'1.0.0': { ...RESOLVED, digest: 'd', hash: 'h', bytes: 1, state: 'ready', at: 0 }
			}
		})
		expect([...env.objects.keys()]).not.toContain('apps/justfiles.draw/1.0.0/spec.json')
	})
})
