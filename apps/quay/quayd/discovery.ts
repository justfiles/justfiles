// Where quayd advertises itself so any client (launcher or booter) can find or
// spawn it. quayd writes runtime.json on boot and clears it on exit; a client
// reads it and, if it is absent or its pid is dead, spawns quayd and waits.

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const dir = join(homedir(), 'Library', 'Application Support', 'quay')
export const runtimePath = join(dir, 'runtime.json')

export interface Runtime {
	port: number
	token: string
	pid: number
}

export async function writeRuntime(runtime: Runtime): Promise<void> {
	await mkdir(dir, { recursive: true })
	await writeFile(runtimePath, JSON.stringify(runtime))
}

export async function clearRuntime(): Promise<void> {
	await rm(runtimePath, { force: true })
}
