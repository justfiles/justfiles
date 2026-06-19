// The Bun side of `#sandbox-url`. Bun's worker module loader throws ENAMETOOLONG on
// a large `data:` URL (it routes data: URLs through a path that blows PATH_MAX ≈ 1KB,
// and a real bundle is many KB — see the migration spike). A `blob:` URL is a short
// reference that resolves at any size, and a blob created on the main thread imports
// fine inside the worker. We don't revoke: workers are content-addressed (bounded by
// distinct bundles) and the daemon idle-exits, so the registry can't grow unbounded.

export function moduleUrl(source: string): string {
	return URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
}
