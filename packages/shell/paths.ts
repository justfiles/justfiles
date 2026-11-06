import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'

/**
 * This shell's own directory: state, record, lock and socket. Never in the Volume.
 * `GHOST_SHELL_DIR` names another one, for a second shell on the same machine.
 */
export function shellDir(): string {
	if (process.env.GHOST_SHELL_DIR) return resolve(process.env.GHOST_SHELL_DIR)
	if (process.platform === 'darwin')
		return join(homedir(), 'Library', 'Application Support', 'ghost')
	return join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'ghost')
}

export const socketPath = (dir: string): string => join(dir, 'ghost.sock')

/** A real directory as a Volume path: its place under `root`, or `/` when outside it. */
export function volumeCwd(cwd: string, root: string): string {
	const rel = relative(root, cwd)
	if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return '/'
	return `/${rel.split(sep).join('/')}`
}

/** A Volume path as a real path under `root`; `..` stops at the Volume's root. */
export function devicePath(path: string, root: string): string {
	return join(root, posix.resolve('/', path).slice(1))
}

/**
 * The rules of asks from `dir`: the nearest `AGENTS.md` in it or above it, as every coding
 * harness finds a root's rules, or undefined without one.
 */
export function rulesFile(
	dir: string,
	exists: (path: string) => boolean = existsSync
): string | undefined {
	for (let at = resolve(dir); ; at = dirname(at)) {
		const file = join(at, 'AGENTS.md')
		if (exists(file)) return file
		if (dirname(at) === at) return undefined
	}
}
