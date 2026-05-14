// Constructs a fresh `Host` per app mount. Per-mount state (later slices:
// agent.describe callback, registered tools) lives on the instance so it
// cannot leak across slot swaps.

import {
	APP_CONTRACT_VERSION,
	type Capabilities,
	type Host,
	NotFoundError,
	type Volume
} from './contract.ts'

// Minimal storage backend the Host Factory needs to scope per-app I/O.
// Matches the subset of `@justfiles/fs.Volume` we use; defined structurally
// so the contract package stays dependency-free.
export interface VolumeBackend {
	readFile(path: string): Promise<Uint8Array>
	writeFile(path: string, data: Uint8Array): Promise<void>
	mkdir(path: string, opts: { recursive: boolean }): Promise<void>
}

export interface CreateHostOptions {
	appId: string
	volume: VolumeBackend
	capabilities: Capabilities
}

export function createHost(opts: CreateHostOptions): Host {
	return Object.freeze({
		version: APP_CONTRACT_VERSION,
		volume: createScopedVolume(opts.appId, opts.volume),
		capabilities: Object.freeze({ ...opts.capabilities })
	})
}

function createScopedVolume(appId: string, backend: VolumeBackend): Volume {
	const scope = `/apps/${appId}/private`

	const scopedPath = (raw: string): string => {
		if (typeof raw !== 'string' || raw.length === 0) {
			throw new Error('volume path must be a non-empty string')
		}
		const segments = raw.split('/').filter((s) => s !== '' && s !== '.')
		if (segments.length === 0) throw new Error('volume path must be a non-empty string')
		for (const s of segments) {
			if (s === '..' || s.includes('\0')) {
				throw new Error(`volume path is not allowed: ${raw}`)
			}
		}
		return `${scope}/${segments.join('/')}`
	}

	const readBytes = async (path: string): Promise<Uint8Array> => {
		try {
			return await backend.readFile(path)
		} catch (err) {
			if (isEnoent(err)) throw new NotFoundError(path)
			throw err
		}
	}

	const writeBytes = async (path: string, data: Uint8Array): Promise<void> => {
		const slash = path.lastIndexOf('/')
		if (slash > 0) await backend.mkdir(path.slice(0, slash), { recursive: true })
		await backend.writeFile(path, data)
	}

	return Object.freeze<Volume>({
		async readText(path) {
			return new TextDecoder().decode(await readBytes(scopedPath(path)))
		},
		async writeText(path, text) {
			await writeBytes(scopedPath(path), new TextEncoder().encode(text))
		},
		async readFile(path) {
			return await readBytes(scopedPath(path))
		},
		async writeFile(path, data) {
			await writeBytes(scopedPath(path), data)
		}
	})
}

const isEnoent = (err: unknown): boolean =>
	err instanceof Error && (err.message.startsWith('ENOENT') || err.name === 'NotFoundError')
