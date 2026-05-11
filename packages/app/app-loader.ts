/// <reference lib="dom" />
// Fetches and mounts a new-contract app. Resolves the manifest's entry
// against `baseUrl`, dynamic-imports the module, validates the default
// export, and calls `mount(el, host)`. Returns a handle that unmounts the
// app exactly once.

import type { App, Host, Manifest } from './contract.js'

export interface LoadAppOptions {
	manifest: Manifest
	/** Base URL the manifest entry resolves against (e.g. `/apps/<id>/`). */
	baseUrl: string
	el: HTMLElement
	host: Host
	/** Test seam — defaults to native dynamic `import()`. */
	importer?: (url: string) => Promise<unknown>
}

export interface AppHandle {
	readonly id: string
	unmount(): Promise<void>
}

export async function loadApp(opts: LoadAppOptions): Promise<AppHandle> {
	const entryUrl = new URL(opts.manifest.entry, opts.baseUrl).toString()
	const importer = opts.importer ?? ((url: string) => import(/* @vite-ignore */ url))

	let module: unknown
	try {
		module = await importer(entryUrl)
	} catch (e) {
		throw new Error(`app entry fetch failed (${entryUrl}): ${String(e)}`)
	}

	const app = extractDefaultApp(module, entryUrl)

	await app.mount(opts.el, opts.host)

	let unmounted = false
	return {
		id: app.id,
		async unmount() {
			if (unmounted) return
			unmounted = true
			await app.unmount()
		}
	}
}

function extractDefaultApp(module: unknown, entryUrl: string): App {
	if (typeof module !== 'object' || module === null) {
		throw new Error(`app entry ${entryUrl} did not return a module object`)
	}
	const def = (module as { default?: unknown }).default
	if (typeof def !== 'object' || def === null) {
		throw new Error(`app entry ${entryUrl} is missing a default export`)
	}
	const candidate = def as Partial<App>
	if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
		throw new Error(`app entry ${entryUrl} default export is missing a string \`id\``)
	}
	if (typeof candidate.mount !== 'function') {
		throw new Error(`app entry ${entryUrl} default export is missing \`mount()\``)
	}
	if (typeof candidate.unmount !== 'function') {
		throw new Error(`app entry ${entryUrl} default export is missing \`unmount()\``)
	}
	return candidate as App
}
