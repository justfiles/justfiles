export interface Config {
	url: string
	key: string
	json: boolean
	quiet: boolean
}

export function loadConfig(overrides: {
	url?: string | boolean
	key?: string | boolean
	json?: boolean
	quiet?: boolean
} = {}): Config {
	return {
		url: (typeof overrides.url === 'string' ? overrides.url : undefined) ?? process.env['GHOSTORE_URL'] ?? 'http://localhost:5173',
		key: (typeof overrides.key === 'string' ? overrides.key : undefined) ?? process.env['GHOSTORE_API_KEY'] ?? '',
		json: overrides.json ?? false,
		quiet: overrides.quiet ?? false,
	}
}
