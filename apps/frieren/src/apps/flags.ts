export function shouldUseLocalKernel(appId: string): boolean {
	const raw = String(import.meta.env.VITE_FRIEREN_LOCAL_APPS ?? '')
	if (!raw) return false
	if (raw === '1' || raw === 'true') return true
	return raw
		.split(',')
		.map((s) => s.trim())
		.includes(appId)
}
