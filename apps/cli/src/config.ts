import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Volume } from '@justfiles/fs'
import { CliUsageError } from './errors.ts'

export type VolumeFactory =
	| {
			create: () => Promise<Volume> | Volume
	  }
	| (() => Promise<Volume> | Volume)

export interface RemoteVolumeConfig {
	type: 'remote'
	url?: string
	token?: string
}

export type VolumeConfig = Volume | string | VolumeFactory | RemoteVolumeConfig

export interface FileConfig {
	defaultVolume?: string
	volumes?: Record<string, VolumeConfig>
}

export interface CliConfig {
	configPath?: string
	configDir: string
	defaultVolume?: string
	volumes: Record<string, VolumeConfig>
	json: boolean
	quiet: boolean
	selectedVolume?: string
}

function configCandidates(): string[] {
	const home = homedir()
	return [
		resolve(process.cwd(), 'files.config.js'),
		resolve(process.cwd(), 'files.config.mjs'),
		resolve(process.cwd(), 'files.config.cjs'),
		join(home, '.config', 'files', 'config.js'),
		join(home, '.config', 'files', 'config.mjs'),
		join(home, '.config', 'files', 'config.cjs'),
		join(home, '.files', 'config.js'),
		join(home, '.files', 'config.mjs'),
		join(home, '.files', 'config.cjs'),
	]
}

async function importConfigModule(filePath: string): Promise<unknown> {
	const loaded = await import(pathToFileURL(filePath).href)
	const candidate = loaded.default ?? loaded
	if (typeof candidate === 'function') {
		return await candidate()
	}
	return candidate
}

function assertFileConfig(value: unknown, filePath: string): FileConfig {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new CliUsageError(`invalid config module: ${filePath}`)
	}

	const config = value as Record<string, unknown>
	if (config.defaultVolume !== undefined && typeof config.defaultVolume !== 'string') {
		throw new CliUsageError(`invalid defaultVolume in ${filePath}: expected a string`)
	}
	if (config.volumes !== undefined && (!config.volumes || typeof config.volumes !== 'object' || Array.isArray(config.volumes))) {
		throw new CliUsageError(`invalid volumes in ${filePath}: expected an object`)
	}

	return {
		defaultVolume: config.defaultVolume as string | undefined,
		volumes: (config.volumes as Record<string, VolumeConfig> | undefined) ?? {},
	}
}

async function loadFileConfig(configPath?: string): Promise<{ path?: string; dir: string; config: FileConfig }> {
	if (configPath) {
		const resolved = isAbsolute(configPath) ? configPath : resolve(process.cwd(), configPath)
		if (!existsSync(resolved)) {
			throw new CliUsageError(`config file not found: ${resolved}`)
		}
		return {
			path: resolved,
			dir: dirname(resolved),
			config: assertFileConfig(await importConfigModule(resolved), resolved),
		}
	}

	for (const candidate of configCandidates()) {
		if (!existsSync(candidate)) continue
		return {
			path: candidate,
			dir: dirname(candidate),
			config: assertFileConfig(await importConfigModule(candidate), candidate),
		}
	}

	return {
		dir: process.cwd(),
		config: { volumes: {} },
	}
}

export async function loadConfig(overrides: {
	config?: string | boolean
	volume?: string | boolean
	json?: boolean
	quiet?: boolean
} = {}): Promise<CliConfig> {
	const selectedVolume =
		(typeof overrides.volume === 'string' ? overrides.volume : undefined) ??
		process.env['FILES_VOLUME']

	const { path, dir, config } = await loadFileConfig(
		typeof overrides.config === 'string' ? overrides.config : undefined
	)

	return {
		configPath: path,
		configDir: dir,
		defaultVolume: config.defaultVolume,
		volumes: config.volumes ?? {},
		json: overrides.json ?? false,
		quiet: overrides.quiet ?? false,
		selectedVolume,
	}
}
