import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export interface Config {
	url: string
	key: string
	json: boolean
	quiet: boolean
}

interface FileConfig {
	url?: string
	key?: string
}

function loadFileConfig(): FileConfig {
	const home = homedir()
	const candidates = [
		join(home, '.config', 'ghostore', 'config.json'),
		join(home, '.ghostore.json'),
	]
	for (const p of candidates) {
		if (existsSync(p)) {
			return JSON.parse(readFileSync(p, 'utf8')) as FileConfig
		}
	}
	return {}
}

export function loadConfig(overrides: {
	url?: string | boolean
	key?: string | boolean
	json?: boolean
	quiet?: boolean
} = {}): Config {
	const file = loadFileConfig()
	return {
		url: (typeof overrides.url === 'string' ? overrides.url : undefined) ?? process.env['GHOSTORE_URL'] ?? file.url ?? 'https://ghostore.net',
		key: (typeof overrides.key === 'string' ? overrides.key : undefined) ?? process.env['GHOSTORE_API_KEY'] ?? file.key ?? '',
		json: overrides.json ?? false,
		quiet: overrides.quiet ?? false,
	}
}
