import { expect, test, vi } from 'vitest'
import { memStore } from './mem.ts'
import { chroot, volume } from './volume.ts'

const bytes = (text: string) => new TextEncoder().encode(text)

test('restricted roots refuse symlink traversal for reads, writes, metadata and directory operations', async () => {
	const fs = volume(memStore())
	await fs.mkdir('/data/app/report', { recursive: true })
	await fs.mkdir('/other')
	await fs.writeFile('/other/secret', bytes('secret'))
	await fs.symlink('/other', '/data/app/report/absolute')
	await fs.symlink('../../../other', '/data/app/report/relative')
	const scoped = chroot(chroot(fs, '/data/app'), '/report', {})
	for (const link of ['absolute', 'relative']) {
		await expect(scoped.readFile(`/${link}/secret`)).rejects.toThrow('EACCES')
		await expect(scoped.writeFile(`/${link}/secret`, bytes('overwrite'))).rejects.toThrow('EACCES')
		await expect(scoped.appendFile(`/${link}/secret`, bytes('append'))).rejects.toThrow('EACCES')
		await expect(scoped.readdir(`/${link}`)).rejects.toThrow('EACCES')
		await expect(scoped.mkdir(`/${link}/dir`, { recursive: true })).rejects.toThrow('EACCES')
		await expect(scoped.chmod(`/${link}/secret`, 0o777)).rejects.toThrow('EACCES')
		await expect(scoped.rm(`/${link}/secret`)).rejects.toThrow('EACCES')
		await expect(scoped.rename(`/${link}/secret`, '/stolen')).rejects.toThrow('EACCES')
		await expect(scoped.cp(`/${link}/secret`, '/stolen')).rejects.toThrow('EACCES')
	}
	expect(await fs.readFile('/other/secret')).toEqual(bytes('secret'))
	expect(() => scoped.readFile('/../other/secret')).toThrow('escapes chroot')
	await scoped.writeFile('/local', bytes('works'))
	expect(await fs.readFile('/data/app/report/local')).toEqual(bytes('works'))
})

test('a symlink in the selected root is refused', async () => {
	const fs = volume(memStore())
	await fs.mkdir('/other')
	await fs.symlink('/other', '/report')
	const scoped = chroot(fs, '/report', {})
	await expect(scoped.mkdir('/', { recursive: true })).rejects.toThrow('EACCES')
})

test('credentials stay excluded through a system grant, copies, listings and nested roots', async () => {
	const fs = volume(memStore())
	await fs.mkdir('/private/credentials', { recursive: true })
	await fs.writeFile('/private/credentials/token', bytes('secret'))
	const scoped = chroot(fs, '/', { deny: ['/private'] })
	await expect(scoped.readFile('/private/credentials/token')).rejects.toThrow('EACCES')
	await expect(scoped.cp('/', '/copy', { recursive: true })).rejects.toThrow('EACCES')
	await expect(scoped.rm('/', { recursive: true })).rejects.toThrow('EACCES')
	expect(await scoped.readdir('/')).toEqual([])
	const paths: string[] = []
	await scoped.scan('/', async (path) => {
		paths.push(path)
	})
	expect(paths).toEqual(['/'])
	const nested = chroot(chroot(fs, '/private'), '/credentials', {
		deny: ['/private']
	})
	await expect(nested.readFile('/token')).rejects.toThrow('EACCES')
})

test('cancellation during a blob write prevents the later file commit', async () => {
	const store = memStore()
	const fs = volume(store)
	await fs.mkdir('/report')
	const stop = new AbortController()
	const put = store.blobs.put
	vi.spyOn(store.blobs, 'put').mockImplementation(async (...args) => {
		await put(...args)
		stop.abort()
	})
	const scoped = chroot(fs, '/report', { signal: stop.signal })
	await expect(scoped.writeFile('/late', bytes('late'))).rejects.toThrow()
	expect(await fs.exists('/report/late')).toBe(false)
})
