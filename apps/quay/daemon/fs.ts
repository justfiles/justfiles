import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type Volume, volume } from '@justfiles/fs'
import { nativeStorage } from '@justfiles/fs/storage/fs'

const supportDir = join(homedir(), 'Library', 'Application Support', 'quay')
const runtimePath = join(supportDir, 'runtime.json')

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
		return volume(await nativeStorage(join(supportDir, 'volume')))
	})()
	return volumeOnce
}

export async function writeRuntime(runtime: Runtime): Promise<void> {
	await mkdir(supportDir, { recursive: true })
	await Bun.write(runtimePath, JSON.stringify(runtime))
}

export async function clearRuntime(): Promise<void> {
	const file = Bun.file(runtimePath)
	if (await file.exists()) await file.delete()
}
