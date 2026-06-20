// quay's ship-time asset bundler under Bun (run with `bun test`). Imports `bundleAsset`
// through the SAME `#assets` specifier build-assets.ts uses, so a green run proves the
// `bun` import condition resolves to Bun.build and the inline-contents + externalised-
// React shapes the launcher assets rely on both hold. Excluded from node vitest.

import { expect, test } from 'bun:test'
import { bundleAsset } from '#assets'

test('#assets bundles inline contents via Bun.build (virtual entry)', async () => {
	const out = await bundleAsset({
		contents: 'globalThis.__probe = 41 + 1; export {}',
		resolveDir: import.meta.dir
	})
	expect(out).toContain('__probe') // the inline source is bundled, not dropped
	expect(out.length).toBeGreaterThan(0)
})

test('#assets leaves external bare specifiers unbundled (the React-importmap shape)', async () => {
	const out = await bundleAsset({
		contents: 'import x from "react"; globalThis.__r = x; export {}',
		resolveDir: import.meta.dir,
		external: ['react']
	})
	// react stays a bare import (resolved by the shell importmap at load), not inlined.
	expect(out).toMatch(/from\s*["']react["']/)
})
