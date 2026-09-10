// The platform-managed AI provider (public name "Just Computer"): nothing to acquire — the
// platform owns the vendor/model and supplies its generate fn — and `builtin`, so Settings
// offers toggles, never connect/disconnect. Kept as a bare function so this package
// needs no @justfiles/agent dependency.

import type { GeneratedImage } from '../../capabilities/image/index.ts'
import type { Provider } from '../provider.ts'

export function platformProvider(deps: {
	generate: (system: string, prompt: string) => Promise<string>
	// Optional: the platform's image engine. Absent (e.g. local dev), the platform backs no
	// image capability and `generateImage` reports unavailable.
	generateImage?: (prompt: string) => Promise<GeneratedImage[]>
}): Provider {
	const generateImage = deps.generateImage
	return {
		id: 'frieren',
		name: 'Just Computer',
		builtin: true,
		auth: { ui: { kind: 'none' }, acquire: async () => ({ accountId: 'frieren', creds: {} }) },
		capabilities: {
			ai: {
				bind: () => ({
					generateText: async ({ system, prompt }) => ({
						text: await deps.generate(typeof system === 'string' ? system : '', prompt)
					})
				})
			},
			...(generateImage && {
				image: {
					bind: () => ({
						generateImage: async ({ prompt }: { prompt: string }) => ({
							images: await generateImage(prompt)
						})
					})
				}
			})
		}
	}
}
