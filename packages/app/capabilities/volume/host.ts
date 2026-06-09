import { chroot, type Volume } from '@justfiles/fs'
import { FileType } from '@justfiles/fs/types'
import { CapabilityError } from '../error.ts'
import { implementCapability } from '../implement.ts'
import { volume } from './index.ts'

// The host implementation of the `volume` capability — one unit pairing the
// `volume` contract with a flat object of typed handlers. `resolveVolume` is the
// host-specific scope→volume policy; everything else (routing, errors, the
// invoke/subscribe split) is the package's job.
//
// Scope semantics:
//   'system'    → the user's root volume (allowlisted apps only)
//   '/prefix'   → chroot at that absolute prefix; /system[/...] requires 'system'
//   'app' / any → per-app chroot at /data/<id>
//
// The frieren-specific value — which apps may bind the `system` scope — is a host
// parameter (`systemAllowlist`), so each host (frieren, desktop) passes its own.

export function resolveVolume(
	fs: Volume,
	appId: string,
	scopes: readonly string[],
	systemAllowlist: ReadonlySet<string>
): { vol: Volume; root: string | null } {
	if (scopes.includes('system')) {
		if (!systemAllowlist.has(appId)) throw unavailable('resolveVolume')
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

export interface VolumeCapabilityOptions {
	// App ids permitted to bind the `system` scope (the user's root volume).
	systemAllowlist?: Iterable<string>
}

// The contract now IS `Volume` (minus the callback-shaped `scan`/`watch`), so
// every data method is a thin scope-resolving passthrough: bind the volume the
// app's scopes grant, then delegate with the same arguments. `writeFile` keeps
// the one host convenience — auto-creating the parent dir — that apps rely on.
export const volumeCapability = (fs: Volume, opts: VolumeCapabilityOptions = {}) => {
	const allow = new Set(opts.systemAllowlist ?? [])

	// Resolve the scoped volume and lazily create the per-app root. Chroot is a
	// path-join wrapper: it does not create its prefix, so a fresh app's first
	// write would miss /data/<id> without this.
	const bind = async (ctx: Ctx): Promise<Volume> => {
		const { vol, root } = resolveVolume(fs, ctx.appId, ctx.scopes, allow)
		if (root && !(await fs.exists(root))) await fs.mkdir(root, { recursive: true })
		return vol
	}

	return implementCapability(volume, {
		stat: async (ctx, path) => (await bind(ctx)).stat(path),
		lstat: async (ctx, path) => (await bind(ctx)).lstat(path),
		exists: async (ctx, path) => (await bind(ctx)).exists(path),
		getXattr: async (ctx, path, name) => (await bind(ctx)).getXattr(path, name),
		setXattr: async (ctx, path, name, value) => (await bind(ctx)).setXattr(path, name, value),
		listXattr: async (ctx, path) => (await bind(ctx)).listXattr(path),
		removeXattr: async (ctx, path, name) => (await bind(ctx)).removeXattr(path, name),
		readFile: async (ctx, path) => (await bind(ctx)).readFile(path),
		writeFile: async (ctx, path, data) => {
			const vol = await bind(ctx)
			await mkdirParent(vol, path)
			await vol.writeFile(path, data)
		},
		appendFile: async (ctx, path, data) => (await bind(ctx)).appendFile(path, data),
		mkdir: async (ctx, path, opts) => (await bind(ctx)).mkdir(path, opts),
		readdir: async (ctx, path) => (await bind(ctx)).readdir(path),
		rm: async (ctx, path, opts) => (await bind(ctx)).rm(path, opts),
		rename: async (ctx, oldPath, newPath) => (await bind(ctx)).rename(oldPath, newPath),
		cp: async (ctx, src, dest, opts) => (await bind(ctx)).cp(src, dest, opts),
		symlink: async (ctx, target, path) => (await bind(ctx)).symlink(target, path),
		readlink: async (ctx, path) => (await bind(ctx)).readlink(path),
		chmod: async (ctx, path, mode) => (await bind(ctx)).chmod(path, mode),
		utimes: async (ctx, path, mtimeNs) => (await bind(ctx)).utimes(path, mtimeNs),
		scan: async (ctx, { path, recursive }) => {
			const vol = await bind(ctx)
			return recursive === true ? scanTree(vol, path) : scanDir(vol, path)
		},
		watch: async (ctx, emit, { path }) => (await bind(ctx)).watch(path, emit)
	})
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

function unavailable(method: string): CapabilityError {
	return new CapabilityError('CAPABILITY_UNAVAILABLE', 'volume', method)
}
