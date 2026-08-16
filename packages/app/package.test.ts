import { expect, test } from 'vitest'
import pkg from './package.json' with { type: 'json' }

// Npm exports are the built form of workspace source exports. `./devkit-runtime`
// is the one exception: the workspace builds from source, while npm copies baked files.

const published = (source: string, ext: string) =>
	`${source.replace(/^\.\//, './dist/').replace(/\.ts$/, '')}${ext}`

test.each(Object.entries(pkg.exports))('%s has its published build', (subpath, source) => {
	const publishSource =
		subpath === './devkit-runtime' ? './capabilities/devkit/devkit-runtime.published.ts' : source
	const entry = (pkg.publishConfig.exports as Record<string, { types: string; default: string }>)[
		subpath
	]
	expect(entry, `publishConfig.exports is missing "${subpath}"`).toBeDefined()
	expect(entry).toEqual({
		types: published(publishSource, '.d.ts'),
		default: published(publishSource, '.js')
	})
})

test('publishConfig exports nothing the workspace does not', () => {
	expect(Object.keys(pkg.publishConfig.exports).sort()).toEqual(Object.keys(pkg.exports).sort())
})
