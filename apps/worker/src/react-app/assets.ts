const ASSET_DIR_NAME = '.assets'
const ASSET_ROOT = `/${ASSET_DIR_NAME}`

export const LARGE_ASSET_REMOTE_THRESHOLD_BYTES = 4 * 1024 * 1024

function splitSegments(path: string): string[] {
	return path.split('/').filter(Boolean)
}

function normalizeSegments(segments: string[]): string[] {
	const out: string[] = []
	for (const segment of segments) {
		if (!segment || segment === '.') continue
		if (segment === '..') {
			out.pop()
			continue
		}
		out.push(segment)
	}
	return out
}

export function normalizeVolumePath(path: string): string {
	return `/${normalizeSegments(splitSegments(path)).join('/')}`.replace(/\/+$/, '') || '/'
}

export function parentVolumePath(path: string): string {
	const normalized = normalizeVolumePath(path)
	const idx = normalized.lastIndexOf('/')
	return idx <= 0 ? '/' : normalized.slice(0, idx)
}

export function basename(path: string): string {
	const normalized = normalizeVolumePath(path)
	const idx = normalized.lastIndexOf('/')
	return idx === -1 ? normalized : normalized.slice(idx + 1)
}

function stem(path: string): string {
	const base = basename(path)
	const idx = base.lastIndexOf('.')
	return idx > 0 ? base.slice(0, idx) : base
}

function normalizedExtension(name: string): string {
	const idx = name.lastIndexOf('.')
	const rawExt = idx > 0 ? name.slice(idx).toLowerCase() : ''
	const ext = rawExt.replace(/[^a-z0-9.]+/g, '')
	return ext
}

export function assetDirPath(): string {
	return ASSET_ROOT
}

export function nextAssetPath(filename: string): string {
	return `${assetDirPath()}/${crypto.randomUUID()}${normalizedExtension(filename)}`
}

export function resolveRelativeFsPath(notePath: string, href: string): string | null {
	if (!href) return null
	if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(href) || href.startsWith('//')) return null

	const base = new URL(`https://justfiles.invalid${normalizeVolumePath(notePath)}`)
	return normalizeVolumePath(new URL(href, base).pathname)
}

export function isAssetPath(path: string): boolean {
	const normalized = normalizeVolumePath(path)
	return normalized === `/${ASSET_DIR_NAME}` || normalized.includes(`/${ASSET_DIR_NAME}/`)
}

/**
 * Where the one-request read route would serve this path. The seam addresses rows by id;
 * this addresses a file by PATH, which is what a `<img src>` can hold.
 */
export function assetUrl(path: string, version: string | null): string {
	const encoded = normalizeVolumePath(path).split('/').map(encodeURIComponent).join('/')
	const suffix = version ? `?v=${encodeURIComponent(version)}` : ''
	return `/store/file${encoded}${suffix}`
}

/** An object URL with no type renders as a download, not an image. */
export function contentTypeOf(filename: string): string {
	const lower = filename.toLowerCase()
	if (lower.endsWith('.png')) return 'image/png'
	if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
	if (lower.endsWith('.gif')) return 'image/gif'
	if (lower.endsWith('.webp')) return 'image/webp'
	if (lower.endsWith('.svg')) return 'image/svg+xml'
	if (lower.endsWith('.pdf')) return 'application/pdf'
	return 'application/octet-stream'
}

export function displayFilenameFromSrc(src: string): string {
	const resolved = src.split(/[?#]/, 1)[0] ?? src
	return basename(resolved) || `${stem(src) || 'file'}`
}
