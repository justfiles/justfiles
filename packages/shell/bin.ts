#!/usr/bin/env node
import { registerHooks } from 'node:module'

// Workspace packages such as @justfiles/fs import their own files without an extension, as
// bundlers allow; node's type stripping needs the `.ts`. Until the binary bundles everything,
// add it here. Registered before anything else loads, so the CLI is imported dynamically.
registerHooks({
	resolve(specifier, context, nextResolve) {
		try {
			return nextResolve(specifier, context)
		} catch (error) {
			const relative = specifier.startsWith('./') || specifier.startsWith('../')
			if ((error as { code?: string }).code !== 'ERR_MODULE_NOT_FOUND' || !relative) throw error
			return nextResolve(`${specifier}.ts`, context)
		}
	}
})

await import('./cli.ts')
