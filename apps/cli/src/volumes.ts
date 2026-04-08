import { resolve } from 'node:path'
import { volume, type Volume } from '@justfiles/fs'
import { nativeStorage } from '@justfiles/fs/storage/fs'
import type { CliConfig, VolumeConfig } from './config.ts'
import { CliUsageError } from './errors.ts'

function isVolumeInstance(config: VolumeConfig): config is Volume {
	if (!config || typeof config !== 'object') return false
	const candidate = config as Partial<Volume>
	return typeof candidate.stat === 'function' &&
		typeof candidate.readFile === 'function' &&
		typeof candidate.writeFile === 'function' &&
		typeof candidate.mkdir === 'function' &&
		typeof candidate.readdir === 'function' &&
		typeof candidate.rm === 'function' &&
		typeof candidate.rename === 'function' &&
		typeof candidate.cp === 'function'
}

function isCustomVolumeConfig(config: VolumeConfig): config is Exclude<VolumeConfig, string | Volume> {
	return typeof config === 'function' || (typeof config === 'object' && config !== null && 'create' in config)
}

function resolveLocalRoot(root: string, configDir: string): string {
	if (root.startsWith('~/')) {
		return resolve(process.env.HOME ?? '', root.slice(2))
	}
	return resolve(configDir, root)
}

async function createLocalVolume(root: string, cliConfig: CliConfig): Promise<Volume> {
	const storage = await nativeStorage(resolveLocalRoot(root, cliConfig.configDir))
	return volume(storage)
}

async function createVolumeFromConfig(config: VolumeConfig, cliConfig: CliConfig): Promise<Volume> {
	if (typeof config === 'string') {
		return await createLocalVolume(config, cliConfig)
	}

	if (isVolumeInstance(config)) {
		return config
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
	if (names.length === 1) return names[0]!

	if (names.length === 0) {
		throw new CliUsageError(
			'no volumes configured. Create files.config.js and define at least one named volume.'
		)
	}

	throw new CliUsageError(
		`multiple volumes configured (${names.join(', ')}). Pass --volume <name> or set defaultVolume in files.config.js.`
	)
}

export async function loadVolume(config: CliConfig): Promise<{ volumeName: string; volume: Volume }> {
	const volumeName = resolveVolumeName(config)
	const volumeConfig = config.volumes[volumeName]
	if (!volumeConfig) {
		throw new CliUsageError(`unknown volume: ${volumeName}`)
	}

	return {
		volumeName,
		volume: await createVolumeFromConfig(volumeConfig, config),
	}
}
