import { expect, test } from 'vitest'
import { chroot, memStorage, volume } from './index'

function bytes(text: string): Uint8Array {
	return new TextEncoder().encode(text)
}

test('chroot maps absolute paths under a subtree', async () => {
	const fs = volume(memStorage())
	await fs.mkdir('/apps/app/data/files', { recursive: true })
	const appFs = chroot(fs, '/apps/app/data/files')

	await appFs.writeFile('/note.txt', bytes('hello'))

	expect(await fs.exists('/note.txt')).toBe(false)
	expect(await fs.exists('/apps/app/data/files/note.txt')).toBe(true)
})

test('chroot rejects parent traversal outside root', async () => {
	const fs = volume(memStorage())
	await fs.mkdir('/root', { recursive: true })
	const appFs = chroot(fs, '/root')

	await expect(async () => await appFs.writeFile('/../escape.txt', bytes('no'))).rejects.toThrow(
		'path escapes chroot'
	)
})
