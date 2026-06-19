// The Node side of the one runtime divergence the Bun migration needs (`#sandbox-url`).
// The sandbox loads an app bundle into a worker via a module URL; Node's worker
// loader accepts only `file:`/`data:`/`node:` schemes, so we encode the source as a
// `data:` URL. (Bun's sibling uses `blob:` — large `data:` URLs blow PATH_MAX in
// Bun's worker resolver; see the migration spike.) Everything else in the sandbox —
// lifecycle, content-addressing, eviction, the wire protocol — is single-source.

export function moduleUrl(source: string): string {
	return `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
}
