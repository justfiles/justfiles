import { CapabilityError, implementCapability } from '@justfiles/app/capabilities'
import { volume } from '@justfiles/app/capabilities/volume'
import { chroot, type Volume } from '@justfiles/fs'
import { FileType } from '@justfiles/fs/types'

// The shared `volume` capability — one unit pairing the `volume` contract with a
// flat object of typed handlers. `resolveVolume` is the host-specific scope→
// volume policy; everything else (routing, errors, the invoke/subscribe split)
// is the package's job.
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

type Ctx = { appId: string; scopes: readonly string[] }

// Resolve the scoped volume and lazily create the per-app root. Chroot is a
// path-join wrapper: it does not create its prefix, so a fresh app's first write
// would miss /data/<id> without this.
async function bind(fs: Volume, ctx: Ctx): Promise<Volume> {
	const { vol, root } = resolveVolume(fs, ctx.appId, ctx.scopes)
	if (root && !(await fs.exists(root))) await fs.mkdir(root, { recursive: true })
	return vol
}

export const volumeCapability = (fs: Volume) =>
	implementCapability(volume, {
		readFile: async ({ path }, ctx) => (await bind(fs, ctx)).readFile(path),
		writeFile: async ({ path, data }, ctx) => {
			const vol = await bind(fs, ctx)
			await mkdirParent(vol, path)
			await vol.writeFile(path, data)
		},
		mkdir: async ({ path, recursive }, ctx) =>
			(await bind(fs, ctx)).mkdir(path, { recursive: recursive !== false }),
		exists: async ({ path }, ctx) => (await bind(fs, ctx)).exists(path),
		scan: async ({ path, recursive }, ctx) => {
			const vol = await bind(fs, ctx)
			return recursive === true ? scanTree(vol, path) : scanDir(vol, path)
		},
		watch: async ({ path }, emit, ctx) => (await bind(fs, ctx)).watch(path, emit)
	})

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

function unavailable(method: string): CapabilityError {
	return new CapabilityError('CAPABILITY_UNAVAILABLE', 'volume', method)
}
