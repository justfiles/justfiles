export function parseFrontmatter(text: string): Record<string, string> {
	const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
	if (!match) return {}
	const out: Record<string, string> = {}
	for (const line of (match[1] ?? '').split(/\r?\n/)) {
		const idx = line.indexOf(':')
		if (idx === -1) continue
		const key = line.slice(0, idx).trim()
		const value = line.slice(idx + 1).trim()
		if (key) out[key] = value
	}
	return out
}
