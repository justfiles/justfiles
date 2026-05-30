// Phase 2b: local (browser-kernel) execution is the default for every app. The
// flag now only ever *narrows* — set it to opt back into the server kernel:
//   unset / '1' / 'true' → all apps run locally
//   '0' / 'false'        → all apps run on the server kernel
//   csv                  → only the listed apps run locally
export function shouldUseLocalKernel(appId: string): boolean {
	const raw = String(import.meta.env.VITE_FRIEREN_LOCAL_APPS ?? '').trim()
	if (!raw || raw === '1' || raw === 'true') return true
	if (raw === '0' || raw === 'false') return false
	return raw
		.split(',')
		.map((s) => s.trim())
		.includes(appId)
}
