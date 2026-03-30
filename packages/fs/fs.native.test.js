import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { nativeFs } from './fs.native.ts'
import { FileType, OpenFlags } from './types.ts'

const tempDirs = []

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true })
	}
})

function fixture(setup) {
	const root = mkdtempSync(join(tmpdir(), 'ghostore-native-fs-'))
	tempDirs.push(root)
	setup(root)
	return root
}

function bytes(text) {
	return new TextEncoder().encode(text)
}

async function expectRejects(action, message) {
	let error
	try {
		await action()
	} catch (caught) {
		error = caught
	}
	if (error === undefined) {
		throw new Error('Expected promise to reject')
	}
	if (message !== undefined) {
		expect(error instanceof Error ? error.message : String(error)).toContain(message)
	}
}

describe('nativeFs', () => {
	test('stats the root inode and resolves existing and missing children', async () => {
		const root = fixture((dir) => {
			writeFileSync(join(dir, 'note.txt'), 'hello')
		})
		const fs = await nativeFs(root)

		expect(await fs.stat(fs.root())).toEqual(expect.objectContaining({
			ino: fs.root(),
			type: FileType.Directory,
		}))

		const noteIno = await fs.lookup(fs.root(), 'note.txt')
		expect(noteIno).not.toBeNull()
		expect(await fs.lookup(fs.root(), 'missing.txt')).toBeNull()
		expect(await fs.stat(noteIno)).toEqual(expect.objectContaining({
			ino: noteIno,
			type: FileType.Regular,
			size: 5n,
		}))
	})

	test('readdir returns names in sorted order and supports cursor continuation', async () => {
		const root = fixture((dir) => {
			writeFileSync(join(dir, 'z-last.txt'), 'z')
			writeFileSync(join(dir, 'a-first.txt'), 'a')
			mkdirSync(join(dir, 'docs'))
		})
		const fs = await nativeFs(root)

		expect(await fs.readdir(fs.root(), '')).toEqual({
			entries: [
				expect.objectContaining({ name: 'a-first.txt', type: FileType.Regular }),
				expect.objectContaining({ name: 'docs', type: FileType.Directory }),
				expect.objectContaining({ name: 'z-last.txt', type: FileType.Regular }),
			],
			next: '',
		})

		expect(await fs.readdir(fs.root(), 'a-first.txt')).toEqual({
			entries: [
				expect.objectContaining({ name: 'docs' }),
				expect.objectContaining({ name: 'z-last.txt' }),
			],
			next: '',
		})
	})

	test('creates regular files and directories via mknod', async () => {
		const root = fixture(() => {})
		const fs = await nativeFs(root)

		const fileIno = await fs.mknod(fs.root(), 'draft.md', FileType.Regular, 0o640)
		const dirIno = await fs.mknod(fs.root(), 'workspace', FileType.Directory, 0o750)

		expect(await fs.stat(fileIno)).toEqual(expect.objectContaining({
			type: FileType.Regular,
			mode: expect.any(Number),
		}))
		expect(await fs.stat(dirIno)).toEqual(expect.objectContaining({
			type: FileType.Directory,
		}))
		expect(readFileSync(join(root, 'draft.md'), 'utf8')).toBe('')
	})

	test('rejects symlink creation through mknod', async () => {
		const root = fixture(() => {})
		const fs = await nativeFs(root)

		await expectRejects(() => fs.mknod(fs.root(), 'link', FileType.Symlink, 0o777), 'EINVAL')
	})

	test('creates symlinks and reads the target', async () => {
		const root = fixture(() => {})
		const fs = await nativeFs(root)

		const linkIno = await fs.symlink(fs.root(), 'notes-link', '../notes/today.md')

		expect(await fs.stat(linkIno)).toEqual(expect.objectContaining({
			type: FileType.Symlink,
		}))
		expect(await fs.readlink(linkIno)).toBe('../notes/today.md')
	})

	test('updates mode and mtime via setattr', async () => {
		const root = fixture((dir) => {
			writeFileSync(join(dir, 'note.txt'), 'hello')
		})
		const fs = await nativeFs(root)
		const noteIno = await fs.lookup(fs.root(), 'note.txt')

		await fs.setattr(noteIno, {
			mode: 0o600,
			mtimeNs: 1_700_000_000_123_000_000n,
		})

		expect(await fs.stat(noteIno)).toEqual(expect.objectContaining({
			mode: expect.any(Number),
			mtimeNs: 1_700_000_000_123_000_000n,
		}))
	})

	test('supports pread, pwrite, truncate, fsync, and close', async () => {
		const root = fixture((dir) => {
			writeFileSync(join(dir, 'note.txt'), 'hello')
		})
		const fs = await nativeFs(root)
		const noteIno = await fs.lookup(fs.root(), 'note.txt')
		const fd = await fs.open(noteIno, OpenFlags.Read | OpenFlags.Write)

		const readBuf = new Uint8Array(2)
		expect(await fs.pread(fd, readBuf, 1n)).toBe(2)
		expect(Array.from(readBuf)).toEqual(Array.from(bytes('el')))

		expect(await fs.pwrite(fd, bytes('!!'), 5n)).toBe(2)
		await fs.fsync(fd)
		await fs.truncate(fd, 4n)
		await fs.close(fd)

		expect(readFileSync(join(root, 'note.txt'), 'utf8')).toBe('hell')
		await expectRejects(() => fs.pread(fd, new Uint8Array(1), 0n), 'EBADF')
	})

	test('updates cached descendants after renaming a directory', async () => {
		const root = fixture((dir) => {
			mkdirSync(join(dir, 'a'))
			writeFileSync(join(dir, 'a', 'file.txt'), 'hello')
		})
		const fs = await nativeFs(root)
		const dirIno = await fs.lookup(fs.root(), 'a')
		const fileIno = await fs.lookup(dirIno, 'file.txt')

		await fs.rename(fs.root(), 'a', fs.root(), 'b')

		expect(await fs.stat(fileIno)).toEqual(expect.objectContaining({
			ino: fileIno,
			type: FileType.Regular,
			size: 5n,
		}))
		expect(await fs.lookup(fs.root(), 'a')).toBeNull()
		expect(readFileSync(join(root, 'b', 'file.txt'), 'utf8')).toBe('hello')
	})

	test('rejects invalid entry names', async () => {
		const root = fixture((dir) => {
			writeFileSync(join(dir, 'note.txt'), 'hello')
		})
		const fs = await nativeFs(root)

		for (const name of ['.', '..', 'dir/file.txt', '']) {
			await expectRejects(() => fs.lookup(fs.root(), name), 'EINVAL')
		}
	})

	test('does not allow reading through a write-only fd', async () => {
		const root = fixture((dir) => {
			writeFileSync(join(dir, 'note.txt'), 'hello')
		})
		const fs = await nativeFs(root)
		const noteIno = await fs.lookup(fs.root(), 'note.txt')
		const fd = await fs.open(noteIno, OpenFlags.Write)

		await expectRejects(() => fs.pread(fd, new Uint8Array(1), 0n))
		await fs.close(fd)
	})

	test('opens a file with write-only OS permissions using OpenFlags.Write', async () => {
		const root = fixture((dir) => {
			const path = join(dir, 'write-only.txt')
			writeFileSync(path, 'x')
			chmodSync(path, 0o200)
		})
		const fs = await nativeFs(root)
		const ino = await fs.lookup(fs.root(), 'write-only.txt')

		const fd = await fs.open(ino, OpenFlags.Write)

		expect(await fs.pwrite(fd, bytes('!'), 0n)).toBe(1)
		await expectRejects(() => fs.pread(fd, new Uint8Array(1), 0n), 'EBADF')
		await fs.close(fd)
		chmodSync(join(root, 'write-only.txt'), 0o644)
		expect(readFileSync(join(root, 'write-only.txt'), 'utf8')).toBe('!')
	})

	test('keeps inode handles usable after unlinking one of multiple hard links', async () => {
		const root = fixture((dir) => {
			writeFileSync(join(dir, 'x.txt'), 'x')
		})
		const fs = await nativeFs(root)
		const ino = await fs.lookup(fs.root(), 'x.txt')

		await fs.link(fs.root(), 'y.txt', ino)
		await fs.unlink(fs.root(), 'x.txt')

		expect(await fs.stat(ino)).toEqual(expect.objectContaining({
			ino,
			type: FileType.Regular,
			nlink: 1,
		}))
	})

	test('preserves inode handles across rename no-op', async () => {
		const root = fixture((dir) => {
			writeFileSync(join(dir, 'x.txt'), 'x')
		})
		const fs = await nativeFs(root)
		const ino = await fs.lookup(fs.root(), 'x.txt')

		await fs.rename(fs.root(), 'x.txt', fs.root(), 'x.txt')

		expect(await fs.stat(ino)).toEqual(expect.objectContaining({
			ino,
			type: FileType.Regular,
		}))
	})

	test('preserves inode handles when renaming onto another hard link of the same file', async () => {
		const root = fixture((dir) => {
			writeFileSync(join(dir, 'a.txt'), 'x')
		})
		const fs = await nativeFs(root)
		const ino = await fs.lookup(fs.root(), 'a.txt')

		await fs.link(fs.root(), 'c.txt', ino)
		await fs.rename(fs.root(), 'a.txt', fs.root(), 'c.txt')

		// POSIX: rename(a, b) where both names are hard links to the same inode is a
		// no-op — both names survive, nlink stays at 2. The point of this test is that
		// stat(ino) does not throw ESTALE, not that nlink reaches 1.
		expect(await fs.stat(ino)).toEqual(expect.objectContaining({
			ino,
			type: FileType.Regular,
		}))
	})
})
