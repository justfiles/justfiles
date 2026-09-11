import type { Volume } from '@justfiles/fs'
import { type Dirent, FileType, type Stat } from '@justfiles/fs/types'
import type { BufferEncoding, FileContent, FsStat, IFileSystem } from 'just-bash'

/**
 * Adapt a @justfiles/fs Volume to just-bash's IFileSystem, so a Bash instance
 * reads and writes the SAME volume the rest of the system shares — no copy, no
 * mirror, no sync. This is the only seam between the two worlds; everything else
 * just-bash does (parsing, ~70 commands, pipes, globs) runs unchanged on top.
 *
 * It is a pure translation layer — just-bash is text / Date / partly-synchronous,
 * Volume is bytes / bigint / fully-async:
 *   - encode/decode bytes ↔ string per the requested BufferEncoding
 *   - Stat.type (FileType enum) ↔ { isFile, isDirectory, isSymbolicLink }
 *   - mtimeNs (bigint) ↔ Date
 *   - POSIX-coded Volume errors ("ENOENT: …") ↔ Node-style `error.code`, which
 *     just-bash commands branch on (e.g. `if (e.code === 'ENOENT')`).
 *
 * The two genuine gaps:
 *   - getAllPaths() is SYNCHRONOUS (it drives glob `*` expansion) but Volume.scan
 *     is async, so we keep a live in-memory path snapshot — seeded with scan('/')
 *     and refreshed off a recursive Volume.watch. A glob is at worst one
 *     watch-tick stale, which is fine.
 *   - link() (hard links) — Volume has no hard links; reject with ENOSYS.
 *
 * `deny` is a hard, uniform read boundary (see paths.SECRET_PREFIXES): because every
 * command (cat, find, tar, sqlite3, jq…) reaches the Volume through this one object,
 * denying here cannot be routed around by a cleverer command line.
 */
export function volumeFs(vol: Volume, deny: readonly string[] = []): IFileSystem {
	const denied = (p: string) => deny.some((d) => p === d || p.startsWith(`${d}/`))
	const eacces = (p: string) =>
		Promise.reject(Object.assign(new Error(`EACCES: permission denied, ${p}`), { code: 'EACCES' }))
	const guard = <T>(p: string, run: () => Promise<T>) => (denied(p) ? eacces(p) : wrap(run()))
	// --- live path snapshot for synchronous getAllPaths (glob expansion) ---
	let paths = new Set<string>(['/'])
	let refreshing = false
	let dirty = false
	async function refresh(): Promise<void> {
		if (refreshing) {
			dirty = true
			return
		}
		refreshing = true
		try {
			do {
				dirty = false
				const next = new Set<string>()
				await vol.scan('/', async (p) => {
					next.add(p)
				})
				paths = next
			} while (dirty)
		} finally {
			refreshing = false
		}
	}
	void refresh()
	void vol.watch(
		'/',
		() => {
			void refresh()
		},
		{ recursive: true }
	)

	async function realpath(input: string): Promise<string> {
		const queue = input.split('/').filter((p) => p !== '')
		let resolved = '/'
		let depth = 0
		while (queue.length > 0) {
			const name = queue.shift() as string
			if (name === '.') continue
			if (name === '..') {
				resolved = parentOf(resolved)
				continue
			}
			const next = resolved === '/' ? `/${name}` : `${resolved}/${name}`
			const st = await vol.lstat(next)
			if (st.type === FileType.Symlink) {
				if (++depth > 40) throw new Error('ELOOP: too many levels of symbolic links')
				const target = await vol.readlink(next)
				if (target.startsWith('/')) resolved = '/'
				queue.unshift(...target.split('/').filter((p) => p !== ''))
			} else {
				resolved = next
			}
		}
		return resolved
	}

	const fs: IFileSystem = {
		readFile: (path, options) =>
			guard(path, () =>
				vol.readFile(path).then((b) => Buffer.from(b).toString(readEncoding(options)))
			),
		readFileBuffer: (path) => guard(path, () => vol.readFile(path)),
		writeFile: (path, content, options) =>
			guard(path, () => vol.writeFile(path, toBytes(content, writeEncoding(options)))),
		appendFile: (path, content, options) =>
			guard(path, () => vol.appendFile(path, toBytes(content, writeEncoding(options)))),
		// `false`, not EACCES: `[ -e … ]` should read as absent, not error out.
		exists: (path) => (denied(path) ? Promise.resolve(false) : vol.exists(path)),
		stat: (path) => guard(path, () => vol.stat(path).then(toFsStat)),
		lstat: (path) => guard(path, () => vol.lstat(path).then(toFsStat)),
		mkdir: (path, options) => guard(path, () => vol.mkdir(path, { recursive: options?.recursive })),
		readdir: (path) =>
			guard(path, () =>
				vol.readdir(path).then((es) => es.map((e) => e.name).filter((n) => !denied(join(path, n))))
			),
		readdirWithFileTypes: (path) =>
			guard(path, () =>
				vol
					.readdir(path)
					.then((es) => es.filter((e) => !denied(join(path, e.name))).map(toDirentEntry))
			),
		rm: (path, options) =>
			guard(path, () => vol.rm(path, { recursive: options?.recursive, force: options?.force })),
		cp: (src, dest, options) =>
			denied(dest)
				? eacces(dest)
				: guard(src, () => vol.cp(src, dest, { recursive: options?.recursive })),
		mv: (src, dest) => (denied(dest) ? eacces(dest) : guard(src, () => vol.rename(src, dest))),
		resolvePath: (base, path) => resolvePath(base, path),
		// Drives glob expansion — filter, or `ls /system/**` enumerates the secrets.
		getAllPaths: () => Array.from(paths).filter((p) => !denied(p)),
		chmod: (path, mode) => guard(path, () => vol.chmod(path, mode)),
		symlink: (target, linkPath) =>
			denied(target) ? eacces(target) : guard(linkPath, () => vol.symlink(target, linkPath)),
		link: () =>
			Promise.reject(
				Object.assign(new Error('ENOSYS: hard links are not supported'), { code: 'ENOSYS' })
			),
		readlink: (path) => guard(path, () => vol.readlink(path)),
		realpath: (path) => guard(path, () => realpath(path)),
		utimes: (path, _atime, mtime) =>
			guard(path, () => vol.utimes(path, BigInt(mtime.getTime()) * 1_000_000n))
	}
	return fs
}

/** Join a directory path and an entry name (no normalisation needed — `name` is a leaf). */
function join(dir: string, name: string): string {
	return dir === '/' ? `/${name}` : `${dir}/${name}`
}

/** Tag a Volume error ("ENOENT: …") with a Node-style `error.code`, then rethrow. */
function rethrow(error: unknown): never {
	if (error instanceof Error) {
		const e = error as Error & { code?: string }
		if (!e.code) {
			const code = /^([A-Z][A-Z0-9]*):/.exec(error.message)?.[1]
			if (code) e.code = code
		}
		throw e
	}
	throw new Error(String(error))
}

const wrap = <T>(p: Promise<T>): Promise<T> => p.catch(rethrow)

function toFsStat(s: Stat): FsStat {
	return {
		isFile: s.type === FileType.Regular,
		isDirectory: s.type === FileType.Directory,
		isSymbolicLink: s.type === FileType.Symlink,
		mode: s.mode,
		size: Number(s.size),
		mtime: new Date(Number(s.mtimeNs / 1_000_000n))
	}
}

function toDirentEntry(d: Dirent): {
	name: string
	isFile: boolean
	isDirectory: boolean
	isSymbolicLink: boolean
} {
	return {
		name: d.name,
		isFile: d.type === FileType.Regular,
		isDirectory: d.type === FileType.Directory,
		isSymbolicLink: d.type === FileType.Symlink
	}
}

function readEncoding(
	options?: BufferEncoding | { encoding?: BufferEncoding | null }
): BufferEncoding {
	if (typeof options === 'string') return options
	return options?.encoding ?? 'utf8'
}

function writeEncoding(options?: BufferEncoding | { encoding?: BufferEncoding }): BufferEncoding {
	if (typeof options === 'string') return options
	return options?.encoding ?? 'utf8'
}

function toBytes(content: FileContent, encoding: BufferEncoding): Uint8Array {
	return typeof content === 'string' ? Buffer.from(content, encoding) : content
}

function parentOf(path: string): string {
	const i = path.lastIndexOf('/')
	return i <= 0 ? '/' : path.slice(0, i)
}

/** Resolve `path` against `base` and normalise (`.`/`..`, leading slash, no trailing). */
function resolvePath(base: string, path: string): string {
	const parts: string[] = []
	for (const seg of `${path.startsWith('/') ? '' : `${base}/`}${path}`.split('/')) {
		if (seg === '' || seg === '.') continue
		if (seg === '..') {
			parts.pop()
			continue
		}
		parts.push(seg)
	}
	return `/${parts.join('/')}`
}
