import { memStorage, type Volume, volume } from '@justfiles/fs'
import { expect, test, vi } from 'vitest'
import { appAssets } from './app-assets'

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)
const text = (value: Uint8Array): string => new TextDecoder().decode(value)

test('the default request has a deadline', async () => {
	const fs = volume(memStorage())
	const signal = new AbortController().signal
	const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(signal)
	const request = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(bytes('GUI')))
	const url = 'https://notes.justapps.run/v/1/gui.js'

	try {
		const cache = await appAssets(fs)
		await cache(url)
		expect(timeout).toHaveBeenCalledWith(10_000)
		expect(request).toHaveBeenCalledWith(url, { signal })
	} finally {
		request.mockRestore()
		timeout.mockRestore()
	}
})

test('a downloaded asset is available after restart without the network', async () => {
	const fs = volume(memStorage())
	let online = true
	let requests = 0
	const request = async (): Promise<Response> => {
		requests++
		if (!online) throw new Error('offline')
		return new Response(bytes('GUI'))
	}
	const url = 'https://notes.justapps.run/v/1/gui.js'

	expect(text(await (await appAssets(fs, request))(url))).toBe('GUI')
	online = false

	expect(text(await (await appAssets(fs, request))(url))).toBe('GUI')
	expect(requests).toBe(1)
})

test('concurrent reads of one uncached URL share one request', async () => {
	const fs = volume(memStorage())
	let requests = 0
	let release: () => void = () => {}
	const pending = new Promise<void>((resolve) => {
		release = resolve
	})
	const cache = await appAssets(fs, async () => {
		requests++
		await pending
		return new Response(bytes('GUI'))
	})
	const url = 'https://notes.justapps.run/v/1/gui.js'

	const reads = [cache(url), cache(url)]
	await Promise.resolve()
	release()

	expect((await Promise.all(reads)).map(text)).toEqual(['GUI', 'GUI'])
	expect(requests).toBe(1)
})

test('a failed response is not cached', async () => {
	const fs = volume(memStorage())
	let requests = 0
	const cache = await appAssets(fs, async () => {
		requests++
		return requests === 1 ? new Response(null, { status: 503 }) : new Response(bytes('GUI'))
	})
	const url = 'https://notes.justapps.run/v/1/gui.js'

	await expect(cache(url)).rejects.toThrow('503')
	expect(text(await cache(url))).toBe('GUI')
	expect(requests).toBe(2)
})

test('a rejected request can be retried', async () => {
	const fs = volume(memStorage())
	let requests = 0
	const cache = await appAssets(fs, async () => {
		requests++
		if (requests === 1) throw new Error('offline')
		return new Response(bytes('GUI'))
	})
	const url = 'https://notes.justapps.run/v/1/gui.js'

	await expect(cache(url)).rejects.toThrow('offline')
	expect(text(await cache(url))).toBe('GUI')
	expect(requests).toBe(2)
})

test('eviction removes only the named URL', async () => {
	const fs = volume(memStorage())
	let online = true
	const cache = await appAssets(fs, async (url) => {
		if (!online) throw new Error('offline')
		return new Response(bytes(url))
	})
	const first = 'https://notes.justapps.run/v/1/gui.js'
	const second = 'https://notes.justapps.run/v/1/icon.png'
	await Promise.all([cache(first), cache(second)])

	await cache.evict?.(first)
	online = false

	await expect(cache(first)).rejects.toThrow('offline')
	expect(text(await cache(second))).toBe(second)
})

test('eviction waits for an in-flight cache write', async () => {
	const fs = volume(memStorage())
	let online = true
	let start: () => void = () => {}
	let release: () => void = () => {}
	const started = new Promise<void>((resolve) => {
		start = resolve
	})
	const pending = new Promise<void>((resolve) => {
		release = resolve
	})
	const cache = await appAssets(fs, async () => {
		if (!online) throw new Error('offline')
		start()
		await pending
		return new Response(bytes('GUI'))
	})
	const url = 'https://notes.justapps.run/v/1/gui.js'
	const read = cache(url)
	await started
	const eviction = cache.evict!(url)
	online = false
	release()

	expect(text(await read)).toBe('GUI')
	await eviction
	await expect(cache(url)).rejects.toThrow('offline')
})

test('eviction waits for an in-flight cache probe', async () => {
	const base = volume(memStorage())
	let startProbe: () => void = () => {}
	let resumeProbe: () => void = () => {}
	const probing = new Promise<void>((resolve) => {
		startProbe = resolve
	})
	const resume = new Promise<void>((resolve) => {
		resumeProbe = resolve
	})
	let block = true
	const fs: Volume = {
		...base,
		async exists(path) {
			if (block && path.startsWith('/private/cache/apps/')) {
				block = false
				startProbe()
				await resume
			}
			return base.exists(path)
		}
	}
	let requests = 0
	const cache = await appAssets(fs, async () => {
		requests++
		if (requests > 1) throw new Error('offline')
		return new Response(bytes('GUI'))
	})
	const url = 'https://notes.justapps.run/v/1/gui.js'
	const read = cache(url)
	await probing
	const eviction = cache.evict!(url)
	resumeProbe()

	expect(text(await read)).toBe('GUI')
	await eviction
	await expect(cache(url)).rejects.toThrow('offline')
})

test('a read started during eviction does not restore the cache', async () => {
	const base = volume(memStorage())
	let startRemove: () => void = () => {}
	let resumeRemove: () => void = () => {}
	const removing = new Promise<void>((resolve) => {
		startRemove = resolve
	})
	const resume = new Promise<void>((resolve) => {
		resumeRemove = resolve
	})
	const fs: Volume = {
		...base,
		async rm(path, options) {
			await base.rm(path, options)
			if (path.startsWith('/private/cache/apps/')) {
				startRemove()
				await resume
			}
		}
	}
	let requests = 0
	const cache = await appAssets(fs, async () => {
		requests++
		if (requests > 1) throw new Error('offline')
		return new Response(bytes('GUI'))
	})
	const url = 'https://notes.justapps.run/v/1/gui.js'
	const eviction = cache.evict!(url)
	await removing

	expect(text(await cache(url))).toBe('GUI')
	resumeRemove()
	await eviction
	await expect(cache(url)).rejects.toThrow('offline')
})

test('the cache uses a flat path-safe URL hash', async () => {
	const fs = volume(memStorage())
	const cache = await appAssets(fs, async () => new Response(bytes('GUI')))
	await cache('https://notes.justapps.run/v/1/assets/gui.js?theme=dark')

	const entries = await fs.readdir('/private/cache/apps')

	expect(entries.map((entry) => entry.name)).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)])
})

test('start removes abandoned temporary files', async () => {
	const fs = volume(memStorage())
	await fs.mkdir('/private/tmp/app-assets', { recursive: true })
	await fs.writeFile('/private/tmp/app-assets/abandoned', bytes('partial'))

	await appAssets(fs, async () => new Response())

	expect(await fs.readdir('/private/tmp/app-assets')).toEqual([])
})

test('start keeps only the newest 500 cached files', async () => {
	const fs = volume(memStorage())
	await fs.mkdir('/private/cache/apps', { recursive: true })
	for (let i = 0; i < 501; i++) {
		const path = `/private/cache/apps/${i.toString(16).padStart(64, '0')}`
		await fs.writeFile(path, bytes(String(i)))
		await fs.utimes(path, BigInt(i))
	}

	await appAssets(fs, async () => new Response())

	const names = (await fs.readdir('/private/cache/apps')).map((entry) => entry.name)
	expect(names).toHaveLength(500)
	expect(names).not.toContain('0'.repeat(64))
	expect(names).toContain((500).toString(16).padStart(64, '0'))
})

test('a cache write failure does not stop an online read', async () => {
	const base = volume(memStorage())
	const fs: Volume = {
		...base,
		async writeFile(path, data, options) {
			if (path.startsWith('/private/')) throw new Error('disk full')
			return base.writeFile(path, data, options)
		}
	}
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

	try {
		const cache = await appAssets(fs, async () => new Response(bytes('GUI')))
		expect(text(await cache('https://notes.justapps.run/v/1/gui.js'))).toBe('GUI')
		expect(warn).toHaveBeenCalledOnce()
	} finally {
		warn.mockRestore()
	}
})

test('a cache startup failure does not stop an online read', async () => {
	const base = volume(memStorage())
	const fs: Volume = {
		...base,
		async mkdir(path, options) {
			if (path === '/private/cache/apps') throw new Error('read only')
			return base.mkdir(path, options)
		}
	}
	const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

	try {
		const cache = await appAssets(fs, async () => new Response(bytes('GUI')))
		expect(text(await cache('https://notes.justapps.run/v/1/gui.js'))).toBe('GUI')
	} finally {
		warn.mockRestore()
	}
})
