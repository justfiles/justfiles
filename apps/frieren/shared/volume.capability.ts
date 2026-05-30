import { chroot, type Volume } from '@justfiles/fs'
import { FileType } from '@justfiles/fs/types'
import { capabilityError } from './capability-error.ts'

// Shared `volume` capability implementation. The SDK proxy forwards the app's
// declared scopes; resolveVolume picks the right backing volume, and
// invokeVolume routes one method call against it.
//
// Scope semantics:
//   'system'    → the user's root volume (allowlisted apps only)
//   '/prefix'   → chroot at that absolute prefix; /system[/...] requires 'system'
//   'app' / any → per-app chroot at /data/<id>

const SYSTEM_SCOPE_ALLOWLIST = new Set(['app.frieren.finder'])

export function resolveVolume(
	fs: Volume,
	appId: string,
	scopes: readonly string[]
): { vol: Volume; root: string | null } {
	if (scopes.includes('system')) {
		if (!SYSTEM_SCOPE_ALLOWLIST.has(appId)) throw unavailable('resolveVolume')
		return { vol: fs, root: null }
	}
	const prefix = scopes.find((s) => s.startsWith('/'))
	if (prefix) {
		if (prefix === '/system' || prefix.startsWith('/system/')) {
			throw unavailable('resolveVolume')
		}
		return { vol: chroot(fs, prefix), root: prefix }
	}
	const root = `/data/${appId}`
	return { vol: chroot(fs, root), root }
}

export async function invokeVolume(
	fs: Volume,
	req: { appId: string; method: string; input: unknown; scopes: readonly string[] }
): Promise<unknown> {
	const { vol, root } = resolveVolume(fs, req.appId, req.scopes)
	// Chroot is a path-join wrapper: it does not create its prefix. The
	// per-app data dir is created lazily here so writes succeed on a fresh
	// app without each handler having to pre-mkdir.
	if (root && !(await fs.exists(root))) await fs.mkdir(root, { recursive: true })
	const input = (req.input ?? {}) as { path?: unknown; data?: unknown; recursive?: unknown }
	if (typeof input.path !== 'string') throw invalid(req.method)
	switch (req.method) {
		case 'readFile':
			return await vol.readFile(input.path)
		case 'writeFile': {
			if (!(input.data instanceof Uint8Array)) throw invalid(req.method)
			await mkdirParent(vol, input.path)
			await vol.writeFile(input.path, input.data)
			return undefined
		}
		case 'mkdir':
			await vol.mkdir(input.path, { recursive: input.recursive !== false })
			return undefined
		case 'exists':
			return await vol.exists(input.path)
		case 'scan':
			return input.recursive === true
				? await scanTree(vol, input.path)
				: await scanDir(vol, input.path)
		default:
			throw unavailable(req.method)
	}
}

async function mkdirParent(vol: Volume, path: string): Promise<void> {
	const parent = path.split('/').slice(0, -1).join('/')
	if (parent) await vol.mkdir(parent, { recursive: true })
}

async function scanDir(
	vol: Volume,
	path: string
): Promise<Array<{ path: string; type: 'file' | 'dir' }>> {
	if (!(await vol.exists(path))) return []
	const base = path.endsWith('/') ? path.slice(0, -1) : path
	const out: Array<{ path: string; type: 'file' | 'dir' }> = []
	for (const entry of await vol.readdir(path)) {
		if (entry.type === FileType.Symlink) continue
		out.push({
			path: `${base}/${entry.name}`,
			type: entry.type === FileType.Directory ? 'dir' : 'file'
		})
	}
	return out
}

// Recursive walk that hits the storage layer's full-volume cursor (one
// network round trip when the backing storage supports it), so callers
// avoid N+1 capability invocations from the sandboxed worker.
async function scanTree(
	vol: Volume,
	path: string
): Promise<Array<{ path: string; type: 'file' | 'dir' }>> {
	if (!(await vol.exists(path))) return []
	const out: Array<{ path: string; type: 'file' | 'dir' }> = []
	await vol.scan(path, async (entryPath, stat) => {
		if (entryPath === path) return
		if (stat.type === FileType.Symlink) return
		out.push({
			path: entryPath,
			type: stat.type === FileType.Directory ? 'dir' : 'file'
		})
	})
	return out
}

function invalid(method: string): Error {
	return capabilityError('CAPABILITY_INVALID_INPUT', 'volume', method)
}

function unavailable(method: string): Error {
	return capabilityError('CAPABILITY_UNAVAILABLE', 'volume', method)
}
