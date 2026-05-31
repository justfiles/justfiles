import { type AppBundle, type AppManifest, safeBundlePath } from '@justfiles/app'
import { unzipSync } from 'fflate'

export function bundleFromZip(zip: Uint8Array): AppBundle {
	const rawEntries = Object.entries(unzipSync(zip))
	const entries = rawEntries.filter(
		([path]) => !path.endsWith('/') && !rawEntries.some(([other]) => other.startsWith(`${path}/`))
	)
	const prefix = entries.some(([path]) => path === 'manifest.json')
		? ''
		: commonTopLevelPrefix(entries.map(([path]) => path))
	const files = new Map<string, Uint8Array>()
	for (const [path, bytes] of entries) {
		files.set(safeBundlePath(prefix ? path.slice(prefix.length) : path), bytes)
	}
	return {
		async manifest() {
			const bytes = files.get('manifest.json')
			if (!bytes) throw new Error('missing manifest.json')
			return JSON.parse(new TextDecoder().decode(bytes)) as AppManifest
		},
		async *list() {
			yield* files.keys()
		},
		async read(path) {
			const bytes = files.get(safeBundlePath(path))
			if (!bytes) throw new Error(`file not found: ${path}`)
			return bytes
		}
	}
}

function commonTopLevelPrefix(paths: string[]): string {
	const roots = new Set(paths.map((path) => path.split('/')[0]).filter(Boolean))
	if (roots.size !== 1) return ''
	const prefix = `${[...roots][0]}/`
	return paths.includes(`${prefix}manifest.json`) ? prefix : ''
}
