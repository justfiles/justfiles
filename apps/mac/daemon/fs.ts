import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type Volume, volume } from '@justfiles/fs'
import { fsStore } from '@justfiles/fs/fs'

// Where the daemon keeps its Volume + runtime.json. Overridable via FRIEREN_SUPPORT_DIR so a test
// can point it at a temp dir and never touch the real support tree; read lazily (a
// function, not a const) so a test can set the env before the first getVolume/writeRuntime.
const supportDir = (): string =>
	process.env.FRIEREN_SUPPORT_DIR ?? join(homedir(), 'Library', 'Application Support', 'Kodama')
const runtimePath = (): string => join(supportDir(), 'runtime.json')

export interface Runtime {
	port: number
	token: string
	pid: number
}

// One volume per process, shared by the kernel and the agent so writes from
// either side hit the same backing store and cache.
let volumeOnce: Promise<Volume> | undefined

export function getVolume(): Promise<Volume> {
	volumeOnce ??= (async () => {
		const root = join(supportDir(), 'volume')
		await mkdir(root, { recursive: true }) // fsStore lstats the root — it must exist
		return volume(fsStore(root))
	})()
	return volumeOnce
}

export async function writeRuntime(runtime: Runtime): Promise<void> {
	await mkdir(supportDir(), { recursive: true })
	await Bun.write(runtimePath(), JSON.stringify(runtime))
}

export async function clearRuntime(): Promise<void> {
	const file = Bun.file(runtimePath())
	if (await file.exists()) await file.delete()
}
