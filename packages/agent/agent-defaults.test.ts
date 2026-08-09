import { volume } from '@justfiles/fs'
import { memStorage } from '@justfiles/fs/storage/mem'
import { describe, expect, test, vi } from 'vitest'
import { createAgentIdentityOwner, PROFILE_PATH, SOUL_PATH } from './agent-defaults.ts'

const bytes = (value: string) => new TextEncoder().encode(value)
const text = (value: Uint8Array) => new TextDecoder().decode(value)

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

describe('agent identity owner', () => {
	test('concurrent first access shares one seed', async () => {
		const fs = volume(memStorage())
		const write = vi.spyOn(fs, 'writeFile')
		const owner = createAgentIdentityOwner(fs)

		await Promise.all([owner.ready(), owner.ready()])

		expect(write).toHaveBeenCalledTimes(2)
		expect(await fs.exists(PROFILE_PATH)).toBe(true)
		expect(await fs.exists(SOUL_PATH)).toBe(true)
	})

	test('a failed seed is retried on later access', async () => {
		const fs = volume(memStorage())
		const actual = fs.writeFile.bind(fs)
		const write = vi
			.spyOn(fs, 'writeFile')
			.mockRejectedValueOnce(new Error('offline'))
			.mockImplementation((...args) => actual(...args))
		const owner = createAgentIdentityOwner(fs)

		await expect(owner.ready()).rejects.toThrow('offline')
		await expect(owner.ready()).resolves.toBeUndefined()
		expect(write).toHaveBeenCalledTimes(3)
	})

	test('an exclusive claim never overwrites identity created by sync', async () => {
		const storage = memStorage()
		const fs = volume(storage)
		const peer = volume(storage)
		await peer.mkdir('/system', { recursive: true })
		await peer.writeFile(PROFILE_PATH, bytes('custom profile'))
		const started = deferred()
		const release = deferred()
		const actual = fs.writeFile.bind(fs)
		vi.spyOn(fs, 'writeFile').mockImplementation(async (...args) => {
			if (args[0] === SOUL_PATH) {
				started.resolve()
				await release.promise
			}
			return actual(...args)
		})
		const ready = createAgentIdentityOwner(fs).ready()
		await started.promise
		await peer.mkdir('/system/agents/main', { recursive: true })
		await peer.writeFile(SOUL_PATH, bytes('synced soul'), { exclusive: true })
		release.resolve()

		await ready
		expect(text(await peer.readFile(SOUL_PATH))).toBe('synced soul')
		expect(text(await peer.readFile(PROFILE_PATH))).toBe('custom profile')
	})

	test('suppression is checked on every entry and is never memoized', async () => {
		const fs = volume(memStorage())
		let suppressed = true
		const owner = createAgentIdentityOwner(fs, () => suppressed)

		await owner.ready()
		expect(await fs.exists(SOUL_PATH)).toBe(false)

		suppressed = false
		await owner.ready()
		expect(await fs.exists(SOUL_PATH)).toBe(true)

		suppressed = true
		await owner.ready()
		expect(await fs.exists(SOUL_PATH)).toBe(true)
	})
})
