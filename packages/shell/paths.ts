import { homedir } from 'node:os'
import { isAbsolute, join, relative, sep } from 'node:path'

/** The root of the Volume on disk. */
export const filesRoot = (): string => join(homedir(), 'files')

/** This shell's own directory: state, record, lock and socket. Never in the Volume. */
export function shellDir(): string {
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
