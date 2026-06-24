import { homedir } from 'node:os'
import { join } from 'node:path'
import { type Volume, volume } from '@justfiles/fs'
import { nativeStorage } from '@justfiles/fs/storage/fs'

// One volume per process, shared by the kernel and the agent so writes from
// either side hit the same backing store and cache.
let volumeOnce: Promise<Volume> | undefined

export function getVolume(): Promise<Volume> {
	volumeOnce ??= (async () => {
		const root = join(homedir(), 'Library', 'Application Support', 'quay', 'volume')
		return volume(await nativeStorage(root))
	})()
	return volumeOnce
}
