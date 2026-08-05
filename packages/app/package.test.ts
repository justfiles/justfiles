import { expect, test } from 'vitest'
import pkg from './package.json' with { type: 'json' }

// In the workspace every subpath resolves to source `.ts`; on npm the same subpath has to
// resolve to what `tsc` emitted. That is two hand-written maps of 30+ entries describing one
// fact, and they had already drifted (four exports had no published counterpart, so those
// imports would have thrown ERR_PACKAGE_PATH_NOT_EXPORTED for every installed consumer).
// The build is plain `tsc` with `rootDir: "."` and `outDir: "./dist"`, so the published path
// is a mechanical transform of the source path — assert exactly that.
const published = (source: string, ext: string) =>
	`${source.replace(/^\.\//, './dist/').replace(/\.ts$/, '')}${ext}`

test.each(Object.entries(pkg.exports))('%s is published as its built self', (subpath, source) => {
	const entry = (pkg.publishConfig.exports as Record<string, { types: string; default: string }>)[
		subpath
	]
	expect(entry, `publishConfig.exports is missing "${subpath}"`).toBeDefined()
	expect(entry).toEqual({ types: published(source, '.d.ts'), default: published(source, '.js') })
})

test('publishConfig exports nothing the workspace does not', () => {
	expect(Object.keys(pkg.publishConfig.exports).sort()).toEqual(Object.keys(pkg.exports).sort())
})
