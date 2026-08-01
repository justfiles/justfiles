import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ensureAgentDefaults } from '@justfiles/agent/defaults'
import { type Volume, volume } from '@justfiles/fs'
import { nativeStorage } from '@justfiles/fs/storage/fs'

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
		await mkdir(root, { recursive: true }) // nativeStorage lstats the root — it must exist
		const vol = volume(await nativeStorage(root))
		// Seed the default soul + empty profile the moment the Volume exists, the way the
		// frieren DO does on reset: the agent works with no onboarding, and Settings' Agent
		// pane has a file to report as "unbound" instead of nothing at all. Idempotent — a
		// personalized soul is never overwritten.
		await ensureAgentDefaults(vol)
		return vol
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
