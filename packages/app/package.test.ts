import { expect, test } from 'vitest'
import pkg from './package.json' with { type: 'json' }

// In the workspace every subpath resolves to source `.ts`; on npm the same subpath has to
// resolve to what `tsc` emitted. That is two hand-written maps of 30+ entries describing one
// fact, and they had already drifted (four exports had no published counterpart, so those
// imports would have thrown ERR_PACKAGE_PATH_NOT_EXPORTED for every installed consumer).
// The build is plain `tsc` with `rootDir: "."` and `outDir: "./dist"`, so the published path
// is a mechanical transform of the source path — assert exactly that.

// `./devkit-runtime` is deliberately workspace-only. Its `buildTypes()` reads this very
// `exports` map expecting SOURCE `.ts` paths and rolls the SDK's `.d.ts` up from them —
// but a published install has `publishConfig.exports` (object-valued, `dist/` only) and no
// `.ts` in the tarball at all, so the subpath could only ever throw there. Frieren and mac
// reach it through the workspace link, where `exports` still points at source.
const WORKSPACE_ONLY = new Set(['./devkit-runtime'])

const publishable = Object.entries(pkg.exports).filter(([subpath]) => !WORKSPACE_ONLY.has(subpath))

const published = (source: string, ext: string) =>
	`${source.replace(/^\.\//, './dist/').replace(/\.ts$/, '')}${ext}`

test.each(publishable)('%s is published as its built self', (subpath, source) => {
	const entry = (pkg.publishConfig.exports as Record<string, { types: string; default: string }>)[
		subpath
	]
	expect(entry, `publishConfig.exports is missing "${subpath}"`).toBeDefined()
	expect(entry).toEqual({ types: published(source, '.d.ts'), default: published(source, '.js') })
})

test('publishConfig exports nothing the workspace does not', () => {
	expect(Object.keys(pkg.publishConfig.exports).sort()).toEqual(
		publishable.map(([subpath]) => subpath).sort()
	)
})

test.each([...WORKSPACE_ONLY])('%s stays out of the published surface', (subpath) => {
	expect(pkg.exports).toHaveProperty(subpath)
	expect(pkg.publishConfig.exports).not.toHaveProperty(subpath)
})
