// Capability-escalation guard + hash-integrity coverage for the store install
// path — the Step 4 additions. Uses a real kernel over an in-memory Volume so the
// installed manifest (which carries `capabilities`) is what the guard reads back.

import { volume } from '@justfiles/fs'
import { memStore } from '@justfiles/fs/mem'
import { describe, expect, test } from 'vitest'
import {
	type AppStore,
	type CatalogApp,
	escalatesCapabilities,
	installApp,
	reconcile
} from './appstore.ts'
import { type GetSandbox, kernel } from './kernel.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()
const sandbox: GetSandbox = async () => ({ run: async () => ({ result: null }) })

async function sha256(bytes: Uint8Array): Promise<string> {
	const buf = bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength
	) as ArrayBuffer
	const digest = await crypto.subtle.digest('SHA-256', buf)
	return `sha256-${[...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')}`
}

type Caps = Record<string, { id: string; scopes: string[] }>

// A catalog app + its file bytes, hashes computed over those exact bytes. The
// version is baked into app.js so a new version has a different whole-app hash.
async function makeApp(id: string, version: string, capabilities: Caps = {}) {
	const manifest = { id, name: id, version, app: 'app.js', capabilities }
	const files = new Map<string, Uint8Array>([
		['manifest.json', enc.encode(JSON.stringify(manifest))],
		['app.js', enc.encode(`// v${version}\nexport const app = {}`)]
	])
	const catalogFiles = await Promise.all(
		[...files].map(async ([path, bytes]) => ({
			path,
			hash: await sha256(bytes),
			size: bytes.byteLength
		}))
	)
	const app: CatalogApp = { id, name: id, version, capabilities, files: catalogFiles }
	return { app, files }
}

// An AppStore over makeApp entries. Optional ids model host-trusted built-ins.
function appStore(
	entries: Awaited<ReturnType<typeof makeApp>>[],
	builtinIds: string[] = []
): AppStore {
	const byId = new Map(entries.map((e) => [e.app.id, e]))
	return {
		async builtins() {
			return builtinIds.flatMap((id) => {
				const entry = byId.get(id)
				return entry ? [entry.app] : []
			})
		},
		async latest(id) {
			return byId.get(id)?.app ?? null
		},
		async read(app, path) {
			const bytes = byId.get(app.id)?.files.get(path)
			if (!bytes) throw new Error(`missing ${app.id}/${path}`)
			return bytes
		}
	}
}

function setup() {
	const fs = volume(memStore())
	return { fs, k: kernel({ fs, sandbox, clock: {} }) }
}

async function installedVersion(fs: ReturnType<typeof volume>, id: string): Promise<string> {
	const bytes = await fs.readFile(`/applications/${id}/manifest.json`)
	return (JSON.parse(dec.decode(bytes)) as { version: string }).version
}

describe('escalatesCapabilities', () => {
	const vol = { volume: { id: 'volume', scopes: ['/a'] } }
	test('equal or narrower does not escalate', () => {
		expect(escalatesCapabilities(vol, vol)).toBe(false)
		expect(escalatesCapabilities(vol, {})).toBe(false)
		expect(escalatesCapabilities(undefined, undefined)).toBe(false)
	})
	test('a new capability id escalates', () => {
		expect(escalatesCapabilities(vol, { ...vol, ai: { id: 'ai', scopes: [] } })).toBe(true)
	})
	test('a broader scope escalates', () => {
		expect(escalatesCapabilities(vol, { volume: { id: 'volume', scopes: ['/a', '/b'] } })).toBe(
			true
		)
	})
})

describe('installApp integrity', () => {
	test('installs when every pinned hash matches', async () => {
		const { fs, k } = setup()
		const { app } = await makeApp('com.x.ok', '1.0.0')
		await installApp(k, appStore([await makeApp('com.x.ok', '1.0.0')]), app)
		expect(await fs.exists('/applications/com.x.ok/app.js')).toBe(true)
	})

	test('rejects a tampered byte (hash mismatch) before it lands', async () => {
		const { fs, k } = setup()
		const good = await makeApp('com.x.tamper', '1.0.0')
		const tampered: AppStore = {
			async builtins() {
				return []
			},
			async latest() {
				return good.app
			},
			async read(_app, path) {
				return path === 'app.js' ? enc.encode('TAMPERED') : (good.files.get(path) as Uint8Array)
			}
		}
		await expect(installApp(k, tampered, good.app)).rejects.toThrow(/hash mismatch/)
		expect(await fs.exists('/applications/com.x.tamper')).toBe(false)
	})
})

describe('reconcile capability-escalation guard', () => {
	test('holds a non-builtin update that declares more capabilities', async () => {
		const { fs, k } = setup()
		const v1 = await makeApp('com.x.app', '1.0.0', { volume: { id: 'volume', scopes: ['/a'] } })
		await installApp(k, appStore([v1]), v1.app)

		const escalated = await makeApp('com.x.app', '1.1.0', {
			volume: { id: 'volume', scopes: ['/a'] },
			ai: { id: 'ai', scopes: [] }
		})
		await reconcile(k, fs, appStore([escalated]))
		expect(await installedVersion(fs, 'com.x.app')).toBe('1.0.0')
	})

	test('auto-applies a non-escalating update', async () => {
		const { fs, k } = setup()
		const v1 = await makeApp('com.x.app2', '1.0.0', { volume: { id: 'volume', scopes: ['/a'] } })
		await installApp(k, appStore([v1]), v1.app)

		const same = await makeApp('com.x.app2', '1.1.0', { volume: { id: 'volume', scopes: ['/a'] } })
		await reconcile(k, fs, appStore([same]))
		expect(await installedVersion(fs, 'com.x.app2')).toBe('1.1.0')
	})

	test('auto-applies capability growth for a trusted first-party built-in', async () => {
		const { fs, k } = setup()
		const v1 = await makeApp('justfiles.notes', '1.0.0', {
			volume: { id: 'volume', scopes: ['/notes'] }
		})
		await installApp(k, appStore([v1]), v1.app)

		const v2 = await makeApp('justfiles.notes', '1.1.0', {
			volume: { id: 'volume', scopes: ['/notes'] },
			ai: { id: 'ai', scopes: [] }
		})
		await reconcile(k, fs, appStore([v2], ['justfiles.notes']))
		expect(await installedVersion(fs, 'justfiles.notes')).toBe('1.1.0')
	})
})
