// Ambient declaration for the build-time virtual module emitted by
// `hostApps()` in `./vite-plugin`. Hosts reference this file via
// `tsconfig.compilerOptions.types: ["@justfiles/app/virtual"]` (or a
// `/// <reference types="@justfiles/app/virtual" />` directive) and can then
// write `import { registry } from 'virtual:@justfiles/apps'` with full types.

declare module 'virtual:@justfiles/apps' {
	export const registry: ReadonlyMap<
		string,
		{
			manifest: {
				format: 1
				name: string
				description: string
				version: string
				entry: string
				backend: string
			}
			code: string
			assets: Record<string, string>
		}
	>
}
