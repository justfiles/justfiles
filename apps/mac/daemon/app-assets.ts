import { createHash, randomUUID } from 'node:crypto'
import type { Volume } from '@justfiles/fs'
import type { FetchAsset } from '../../../packages/app/kernel.app'

const CACHE_ROOT = '/private/cache/apps'
const TMP_ROOT = '/private/tmp/app-assets'
const MAX_FILES = 500
const REQUEST_TIMEOUT_MS = 10_000

export async function appAssets(
	fs: Volume,
	request: (url: string) => Promise<Response> = (url) =>
		fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
): Promise<FetchAsset> {
	// Cache faults must not block a network read.
	await startCache(fs).catch((error) => console.warn('app asset: cache start failed', error))
	const pending = new Map<string, Promise<Uint8Array>>()

	const load = (url: string): Promise<Uint8Array> => {
		let read = pending.get(url)
		if (!read) {
			read = (async () => {
				const path = cachePath(url)
				if (await fs.exists(path)) return fs.readFile(path)

				const response = await request(url)
				if (!response.ok) throw new Error(`app asset: ${url} ${response.status}`)
				const data = new Uint8Array(await response.arrayBuffer())
				const tmp = `${TMP_ROOT}/${randomUUID()}`
				try {
					await fs.writeFile(tmp, data)
					await fs.rename(tmp, path)
				} catch (error) {
					await fs.rm(tmp, { force: true }).catch(() => {})
					console.warn(`app asset: cache write failed for ${url}`, error)
				}
				return data
			})().finally(() => pending.delete(url))
			pending.set(url, read)
		}
		return read
	}
	load.evict = async (url: string) => {
		await pending.get(url)?.catch(() => {})
		await fs.rm(cachePath(url), { force: true })
	}
	return load
}

const cachePath = (url: string): string =>
	`${CACHE_ROOT}/${createHash('sha256').update(url).digest('hex')}`

async function startCache(fs: Volume): Promise<void> {
	await fs.mkdir(CACHE_ROOT, { recursive: true })
	await fs.rm(TMP_ROOT, { recursive: true, force: true })
	await fs.mkdir(TMP_ROOT, { recursive: true })
	const cached = await Promise.all(
		(await fs.readdir(CACHE_ROOT)).map(async ({ name }) => ({
			name,
			mtimeNs: (await fs.stat(`${CACHE_ROOT}/${name}`)).mtimeNs
		}))
	)
	cached.sort((a, b) => {
		if (a.mtimeNs === b.mtimeNs) return b.name.localeCompare(a.name)
		return a.mtimeNs > b.mtimeNs ? -1 : 1
	})
	await Promise.all(
		cached
			.slice(MAX_FILES)
			.map(({ name }) => fs.rm(`${CACHE_ROOT}/${name}`, { recursive: true, force: true }))
	)
}
