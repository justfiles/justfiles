import { type Volume, volume } from '@justfiles/fs'
import { memStorage } from '@justfiles/fs/storage/mem'
import { Bash } from 'just-bash'
import { describe, expect, test } from 'vitest'
import { volumeFs } from './volume-fs.ts'

const enc = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder().decode(b)
/** Let the async path-snapshot (scan + recursive watch) settle. */
const flush = () => new Promise((r) => setTimeout(r, 10))

function fresh(): { vol: Volume; fs: ReturnType<typeof volumeFs> } {
	const vol = volume(memStorage())
	return { vol, fs: volumeFs(vol) }
}

describe('files', () => {
	test('read/write round-trips as utf8 by default', async () => {
		const { fs } = fresh()
		await fs.writeFile('/f', 'héllo')
		expect(await fs.readFile('/f')).toBe('héllo')
		expect(dec(await fs.readFileBuffer('/f'))).toBe('héllo')
	})

	test('honours an explicit encoding both ways', async () => {
		const { fs } = fresh()
		await fs.writeFile('/f', 'aGVsbG8=', 'base64') // "hello"
		expect(await fs.readFile('/f')).toBe('hello')
		expect(await fs.readFile('/f', 'base64')).toBe('aGVsbG8=')
		expect(await fs.readFile('/f', 'hex')).toBe('68656c6c6f')
	})

	test('writes a Uint8Array verbatim', async () => {
		const { fs, vol } = fresh()
		await fs.writeFile('/b', enc('raw'))
		expect(dec(await vol.readFile('/b'))).toBe('raw')
	})

	test('append extends an existing file', async () => {
		const { fs } = fresh()
		await fs.writeFile('/f', 'a')
		await fs.appendFile('/f', 'b')
		expect(await fs.readFile('/f')).toBe('ab')
	})

	test('writes land in the same volume', async () => {
		const { fs, vol } = fresh()
		await fs.writeFile('/shared', 'x')
		expect(dec(await vol.readFile('/shared'))).toBe('x')
	})
})

describe('stat', () => {
	test('reports type, size and mtime', async () => {
		const { fs } = fresh()
		await fs.writeFile('/f', 'hello')
		const s = await fs.stat('/f')
		expect(s.isFile).toBe(true)
		expect(s.isDirectory).toBe(false)
		expect(s.size).toBe(5)
		expect(s.mtime).toBeInstanceOf(Date)
	})

	test('utimes sets mtime; stat reads it back', async () => {
		const { fs } = fresh()
		await fs.writeFile('/f', 'x')
		const t = new Date('2020-01-01T00:00:00.000Z')
		await fs.utimes('/f', t, t)
		expect((await fs.stat('/f')).mtime.getTime()).toBe(t.getTime())
	})
})

describe('directories', () => {
	test('mkdir recursive then readdir', async () => {
		const { fs } = fresh()
		await fs.mkdir('/a/b/c', { recursive: true })
		await fs.writeFile('/a/file', 'y')
		expect(new Set(await fs.readdir('/a'))).toEqual(new Set(['b', 'file']))
	})

	test('readdirWithFileTypes carries the type', async () => {
		const { fs } = fresh()
		await fs.mkdir('/a/sub', { recursive: true })
		await fs.writeFile('/a/file', 'y')
		const entries = await fs.readdirWithFileTypes?.('/a')
		expect(entries?.find((e) => e.name === 'sub')?.isDirectory).toBe(true)
		expect(entries?.find((e) => e.name === 'file')?.isFile).toBe(true)
	})
})

describe('mutation', () => {
	test('rm removes files and (recursively) trees, force ignores missing', async () => {
		const { fs } = fresh()
		await fs.mkdir('/d', { recursive: true })
		await fs.writeFile('/d/f', 'x')
		await fs.rm('/d/f')
		expect(await fs.exists('/d/f')).toBe(false)
		await fs.rm('/d', { recursive: true })
		expect(await fs.exists('/d')).toBe(false)
		await expect(fs.rm('/ghost', { force: true })).resolves.toBeUndefined()
	})

	test('cp copies file contents', async () => {
		const { fs } = fresh()
		await fs.writeFile('/src', 'data')
		await fs.cp('/src', '/dst')
		expect(await fs.readFile('/dst')).toBe('data')
	})

	test('mv renames', async () => {
		const { fs } = fresh()
		await fs.writeFile('/m1', 'm')
		await fs.mv('/m1', '/m2')
		expect(await fs.exists('/m1')).toBe(false)
		expect(await fs.readFile('/m2')).toBe('m')
	})

	test('chmod changes the mode bits', async () => {
		const { fs } = fresh()
		await fs.writeFile('/f', 'x')
		await fs.chmod('/f', 0o600)
		expect((await fs.stat('/f')).mode).toBe(0o600)
	})
})

describe('symlinks', () => {
	test('symlink / readlink / lstat / stat follow vs not', async () => {
		const { fs } = fresh()
		await fs.mkdir('/d', { recursive: true })
		await fs.writeFile('/d/target', 'x')
		await fs.symlink('/d/target', '/link')
		expect(await fs.readlink('/link')).toBe('/d/target')
		expect((await fs.lstat('/link')).isSymbolicLink).toBe(true)
		expect((await fs.stat('/link')).isFile).toBe(true)
	})

	test('realpath resolves links, including intermediate dir links', async () => {
		const { fs } = fresh()
		await fs.mkdir('/d', { recursive: true })
		await fs.writeFile('/d/target', 'x')
		await fs.symlink('/d/target', '/link')
		await fs.symlink('/d', '/dlink')
		expect(await fs.realpath('/link')).toBe('/d/target')
		expect(await fs.realpath('/dlink/target')).toBe('/d/target')
	})

	test('link (hard link) is unsupported', async () => {
		const { fs } = fresh()
		await fs.writeFile('/f', 'x')
		await expect(fs.link('/f', '/hard')).rejects.toMatchObject({ code: 'ENOSYS' })
	})
})

describe('errors carry a POSIX code', () => {
	test('missing paths reject with code ENOENT', async () => {
		const { fs } = fresh()
		await expect(fs.stat('/nope')).rejects.toMatchObject({ code: 'ENOENT' })
		await expect(fs.readFile('/nope')).rejects.toMatchObject({ code: 'ENOENT' })
	})
})

describe('path helpers', () => {
	test('resolvePath joins relative and passes absolute through', () => {
		const { fs } = fresh()
		expect(fs.resolvePath('/work', 'a/b')).toBe('/work/a/b')
		expect(fs.resolvePath('/work', '/abs')).toBe('/abs')
		expect(fs.resolvePath('/work', '../x')).toBe('/x')
	})

	test('getAllPaths reflects the tree (eventually)', async () => {
		const { fs } = fresh()
		await fs.writeFile('/p1', '1')
		await fs.mkdir('/pd')
		await flush()
		const all = fs.getAllPaths()
		expect(all).toContain('/p1')
		expect(all).toContain('/pd')
	})
})

describe('drives a real Bash over the volume', () => {
	test('cat / redirect / glob run against the shared volume', async () => {
		const vol = volume(memStorage())
		await vol.mkdir('/work')
		await vol.writeFile('/work/a.txt', enc('hello\n'))
		await vol.writeFile('/work/b.txt', enc('world\n'))

		const bash = new Bash({ fs: volumeFs(vol), cwd: '/work' })

		expect((await bash.exec('cat a.txt')).stdout).toBe('hello\n')

		await bash.exec('echo hi > c.txt')
		expect(dec(await vol.readFile('/work/c.txt'))).toBe('hi\n')

		await flush()
		const glob = (await bash.exec('echo *.txt')).stdout.trim()
		expect(glob).toContain('a.txt')
		expect(glob).toContain('b.txt')
		expect(glob).toContain('c.txt')
	})
})

// The secret boundary (#284 §7): `/system/accounts` holds live OAuth tokens in clear text
// and the agent's shell is rooted at `/`. It is enforced HERE, at the one seam all ~83
// commands share, so no clever command line can route around it — and the NAMES stay
// invisible too, not just the bytes.
describe('denied prefixes', () => {
	const DENY = ['/system/accounts']

	async function denied(): Promise<{ vol: Volume; bash: Bash }> {
		const vol = volume(memStorage())
		await vol.mkdir('/system/accounts', { recursive: true })
		await vol.writeFile('/system/accounts/google.json', enc('{"token":"SECRET"}'))
		await vol.writeFile('/system/user.md', enc('name: Ada\n'))
		const bash = new Bash({ fs: volumeFs(vol, DENY), cwd: '/' })
		await flush()
		return { vol, bash }
	}

	test('no command reads a denied file, however it is reached', async () => {
		const { bash } = await denied()
		for (const command of [
			'cat /system/accounts/google.json',
			'head -1 /system/accounts/google.json',
			'grep token /system/accounts/google.json',
			'cp /system/accounts/google.json /leak.json',
			'tar -cf /leak.tar /system/accounts',
			'find /system/accounts -type f'
		]) {
			const result = await bash.exec(command)
			expect(result.exitCode, command).not.toBe(0)
			expect(`${result.stdout}${result.stderr}`, command).not.toContain('SECRET')
		}
		expect((await bash.exec('cat /leak.json')).exitCode).not.toBe(0)
	})

	test('listing hides the denied entry, including through a glob', async () => {
		const { bash } = await denied()
		const ls = await bash.exec('ls /system')
		expect(ls.stdout).toContain('user.md')
		expect(ls.stdout).not.toContain('accounts')
		expect((await bash.exec('find /system')).stdout).not.toContain('accounts')
		expect((await bash.exec('echo /system/*')).stdout).not.toContain('accounts')
		expect((await bash.exec('echo /system/accounts/*')).stdout).not.toContain('google.json')
		const grep = await bash.exec('grep -r SECRET /system')
		expect(`${grep.stdout}${grep.stderr}`).not.toContain('SECRET')
	})

	test('sibling paths under the same parent are untouched', async () => {
		const { bash } = await denied()
		expect((await bash.exec('cat /system/user.md')).stdout).toBe('name: Ada\n')
		await bash.exec('echo ok > /system/other.txt')
		expect((await bash.exec('cat /system/other.txt')).stdout).toBe('ok\n')
	})

	test('exists reads as absent (not an error), and writes are refused', async () => {
		const vol = volume(memStorage())
		await vol.mkdir('/system/accounts', { recursive: true })
		await vol.writeFile('/system/accounts/google.json', enc('{}'))
		const fs = volumeFs(vol, DENY)
		expect(await fs.exists('/system/accounts/google.json')).toBe(false)
		await expect(fs.readFile('/system/accounts/google.json')).rejects.toMatchObject({
			code: 'EACCES'
		})
		await expect(fs.writeFile('/system/accounts/evil.json', 'x')).rejects.toMatchObject({
			code: 'EACCES'
		})
		await expect(fs.rm('/system/accounts', { recursive: true })).rejects.toMatchObject({
			code: 'EACCES'
		})
	})
})
