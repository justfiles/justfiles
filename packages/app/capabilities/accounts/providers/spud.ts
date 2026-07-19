// The platform-managed AI provider ("Spud AI"): nothing to acquire — the platform
// owns the vendor/model and supplies its generate fn — and `builtin`, so Settings
// offers toggles, never connect/disconnect. Kept as a bare function so this package
// needs no @justfiles/agent dependency.

import type { Provider } from '../provider.ts'

export function spudProvider(deps: {
	generate: (system: string, prompt: string) => Promise<string>
}): Provider {
	return {
		id: 'spud',
		name: 'Spud AI',
		builtin: true,
		auth: { ui: { kind: 'none' }, acquire: async () => ({ accountId: 'spud', creds: {} }) },
		capabilities: {
			ai: {
				bind: () => ({
					generateText: async ({ system, prompt }) => ({
						text: await deps.generate(typeof system === 'string' ? system : '', prompt)
					})
				})
			}
		}
	}
}
