import { resolve } from 'node:path'
import { apiStorage, createFsClient } from '@justfiles/core/fs.client'
import { type Volume, volume } from '@justfiles/fs'
import { nativeStorage } from '@justfiles/fs/storage/fs'
import type { CliConfig, RemoteVolumeConfig, VolumeConfig } from './config.ts'
import { CliUsageError } from './errors.ts'

const DEFAULT_REMOTE_VOLUME_URL = 'https://justfiles.app'
const REMOTE_TOKEN_ENV_KEYS = ['JUSTFILES_TOKEN', 'FILES_TOKEN', 'API_KEY'] as const

function isVolumeInstance(config: VolumeConfig): config is Volume {
	if (!config || typeof config !== 'object') return false
	const candidate = config as Partial<Volume>
	return (
		typeof candidate.stat === 'function' &&
		typeof candidate.readFile === 'function' &&
		typeof candidate.writeFile === 'function' &&
		typeof candidate.mkdir === 'function' &&
		typeof candidate.readdir === 'function' &&
		typeof candidate.rm === 'function' &&
		typeof candidate.rename === 'function' &&
		typeof candidate.cp === 'function'
	)
}

function isCustomVolumeConfig(
	config: VolumeConfig
): config is Exclude<VolumeConfig, string | Volume> {
	return (
		typeof config === 'function' ||
		(typeof config === 'object' && config !== null && 'create' in config)
	)
}

function isRemoteVolumeConfig(config: VolumeConfig): config is RemoteVolumeConfig {
	return (
		typeof config === 'object' && config !== null && 'type' in config && config.type === 'remote'
	)
}

function resolveLocalRoot(root: string, configDir: string): string {
	if (root.startsWith('~/')) {
		return resolve(process.env.HOME ?? '', root.slice(2))
	}
	return resolve(configDir, root)
}

function resolveFsBaseUrl(url: string): string {
	let resolved: URL
	try {
		resolved = new URL(url)
	} catch {
		throw new CliUsageError(`invalid remote volume url: ${url}`)
	}

	const pathname = resolved.pathname.replace(/\/+$/, '') || '/'
	if (pathname === '/fs') {
		resolved.pathname = '/fs'
		return resolved.toString()
	}

	resolved.pathname = pathname === '/' ? '/fs' : `${pathname}/fs`
	return resolved.toString()
}

function resolveRemoteToken(config: RemoteVolumeConfig): string {
	const configuredToken = config.token?.trim()
	if (configuredToken) return configuredToken

	for (const key of REMOTE_TOKEN_ENV_KEYS) {
		const value = process.env[key]?.trim()
		if (value) return value
	}

	throw new CliUsageError(
		`remote volume token is required. Set volumes.<name>.token or one of ${REMOTE_TOKEN_ENV_KEYS.join(', ')}.`
	)
}

async function createLocalVolume(root: string, cliConfig: CliConfig): Promise<Volume> {
	const storage = await nativeStorage(resolveLocalRoot(root, cliConfig.configDir))
	return volume(storage)
}

function encodeVolumePath(path: string): string {
	return path.split('/').map(encodeURIComponent).join('/')
}

async function createRemoteVolume(config: RemoteVolumeConfig): Promise<Volume> {
	const token = resolveRemoteToken(config)
	const baseUrl = resolveFsBaseUrl(config.url ?? DEFAULT_REMOTE_VOLUME_URL)
	const headers = {
		Authorization: `Bearer ${token}`
	}
	const client = createFsClient({
		baseUrl,
		headers
	})

	const baseVolume = volume(await apiStorage(client))
	return {
		...baseVolume,
		async readFile(path) {
			const url = new URL(`${baseUrl}/file${encodeVolumePath(path)}`)
			const res = await fetch(url, { headers })
			if (res.ok) return new Uint8Array(await res.arrayBuffer())

			let message = `readFile failed: ${res.status}`
			const contentType = res.headers.get('content-type') ?? ''
			if (contentType.includes('application/json')) {
				const payload = (await res.json()) as { error?: string }
				if (typeof payload.error === 'string') message = payload.error
			}

			if (message.startsWith('ENOENT:') || message.startsWith('EISDIR:')) {
				throw new Error(message)
			}

			console.warn(
				`[files] remote read fast path failed for ${path}: ${message}; falling back to inode walk`
			)
			return baseVolume.readFile(path)
		}
	}
}

async function createVolumeFromConfig(config: VolumeConfig, cliConfig: CliConfig): Promise<Volume> {
	if (typeof config === 'string') {
		return await createLocalVolume(config, cliConfig)
	}

	if (isVolumeInstance(config)) {
		return config
	}

	if (isRemoteVolumeConfig(config)) {
		return await createRemoteVolume(config)
	}

	if (isCustomVolumeConfig(config)) {
		const factory = typeof config === 'function' ? config : config.create
		return await factory()
	}

	throw new CliUsageError('invalid volume config')
}

function resolveVolumeName(config: CliConfig): string {
	if (config.selectedVolume) return config.selectedVolume

	if (config.defaultVolume) return config.defaultVolume

	const names = Object.keys(config.volumes)
	if (names.length === 1) {
		const [name] = names
		if (name !== undefined) return name
	}

	if (names.length === 0) {
		throw new CliUsageError(
			'no volumes configured. Create files.config.js and define at least one named volume.'
		)
	}

	throw new CliUsageError(
		`multiple volumes configured (${names.join(', ')}). Pass --volume <name> or set defaultVolume in files.config.js.`
	)
}

export async function loadVolume(
	config: CliConfig
): Promise<{ volumeName: string; volume: Volume }> {
	const volumeName = resolveVolumeName(config)
	const volumeConfig = config.volumes[volumeName]
	if (!volumeConfig) {
		throw new CliUsageError(`unknown volume: ${volumeName}`)
	}

	return {
		volumeName,
		volume: await createVolumeFromConfig(volumeConfig, config)
	}
}
