// The platform-framework specifiers app code links against the HOST's copy instead of
// bundling — the dylib / VS Code `vscode`-module model. This is the ONE source of truth
// for "what is external": both compile paths (kernelHost and the devkit toolchain) read
// it to mark these specifiers external, and the host importmap / vendor emit is generated
// from it — so the author surface, both resolvers, and the served modules can't drift.

// The sync asm build (no WASM, no `await init`) of the same tokenizer Vite uses for import
// analysis. Both the compile-time sentinel rewrite and the spawn-time resolve parse rather
// than regex because a reducer bundle can be 3rd-party and untrusted: a real tokenizer only
// ever touches REAL import specifiers, never an import-like substring inside a string
// literal or comment (e.g. Code's embedded starter template `import … from '@justfiles/app'`).
import { parse } from 'es-module-lexer/js'

// React family. Externalized in the GUI compile only — the host importmap resolves a
// bare `react` to the one shared React instance in the document. A reducer worker has no
// importmap, so React MUST NOT appear in a reducer-reachable module; `buildRuntime`
// guards that (see `sdkExternals` `reducer` below).
export const reactExternals = [
	'react',
	'react-dom',
	'react-dom/client',
	'react/jsx-runtime',
	'react/jsx-dev-runtime'
]

// The platform SDK + valibot, each pre-built by the host once (`buildRuntime`) into a
// self-contained ESM module and served at `/vendor/<spec>.js`. Vendor URLs MIRROR the
// specifier — no hyphen-mangling — because a path with `@`/`/` is a valid URL
// (`@justfiles/app/capabilities/volume` → `/vendor/@justfiles/app/capabilities/volume.js`).
//
// `reducer: true` = reducer-reachable, so it must stay react-free. `@justfiles/app/react`
// (the React GUI entry) and `@justfiles/app/browser` (the `defineGUI` host bindings) are
// GUI-only and may pull React, so they're `reducer: false` and excluded from the guard.
//
// NOTE: esbuild's `external` matches a package AND all its subpaths, so the reducer
// compile externalizes EVERY `@justfiles/app/*` import a reducer makes — which means this
// list must enumerate every capability-client subpath a reducer can import (not just the
// USE capabilities). `devkit` (Code) and `accounts` (Settings) are gated at the host, but
// their client factories are imported by those reducers, so they're vendored like the rest;
// the grant is enforced on invocation, never on import.
export const sdkExternals: readonly { spec: string; reducer: boolean }[] = [
	{ spec: '@justfiles/app', reducer: true },
	{ spec: '@justfiles/app/react', reducer: false },
	{ spec: '@justfiles/app/browser', reducer: false },
	{ spec: '@justfiles/app/capabilities/volume', reducer: true },
	{ spec: '@justfiles/app/capabilities/notify', reducer: true },
	{ spec: '@justfiles/app/capabilities/email', reducer: true },
	{ spec: '@justfiles/app/capabilities/calendar', reducer: true },
	{ spec: '@justfiles/app/capabilities/ai', reducer: true },
	{ spec: '@justfiles/app/capabilities/devkit', reducer: true },
	{ spec: '@justfiles/app/capabilities/accounts', reducer: true },
	{ spec: 'valibot', reducer: true }
]

// Every externalized specifier — the allowlist both compile-path resolvers mark external.
export const externals = [...reactExternals, ...sdkExternals.map((s) => s.spec)]

// The reducer sentinel prefix. A reducer worker has no importmap, so the compiler can't
// leave a bare SDK specifier — it emits `justfiles-sdk:<spec>` and the host rewrites each
// at spawn to a module URL the worker can load. Shared by BOTH compile paths (Step 2) and
// the spawn resolver (Step 3) so the emitted sentinel and the rewrite can't drift.
export const SDK_SENTINEL = 'justfiles-sdk:'

const SDK_SPECS = new Set(sdkExternals.map((s) => s.spec))

// Is `spec` a platform SDK specifier? Both compile paths externalize these as BARE
// specifiers (the gui keeps them for the host importmap; the reducer's are then rewritten
// by `sentinelizeReducer`). React is handled separately via the bundler's top-level
// `external`, so it's deliberately not in this set.
export function isSdkSpec(spec: string): boolean {
	return SDK_SPECS.has(spec)
}

// Walk a bundle's imports with es-module-lexer and rewrite each specifier via
// `map(spec) -> replacement | undefined` (undefined = leave untouched). Lexer-based, NOT
// regex, so it only rewrites real import specifiers — never an import-like substring in a
// string literal/comment (the whole reason both rewrites below are safe on untrusted code).
// Handles the lexer's two range conventions: a STATIC import's `[s,e)` excludes the quotes,
// a DYNAMIC `import()`'s includes them — so we re-wrap by the char at `s`. A computed
// dynamic `import(x)` reports `n === undefined` and is skipped.
function rewriteImports(code: string, map: (spec: string) => string | undefined): string {
	const [imports] = parse(code)
	let out = ''
	let last = 0
	for (const { n, s, e } of imports) {
		if (n === undefined) continue
		const next = map(n)
		if (next === undefined) continue
		const q = code[s]
		const quoted = q === '"' || q === "'" || q === '`'
		out += code.slice(last, s) + (quoted ? q + next + q : next)
		last = e
	}
	return out + code.slice(last)
}

// Rewrite each bare SDK import in a compiled REDUCER to the `justfiles-sdk:` sentinel the
// host resolves at spawn (a Worker has no importmap, so it can't carry a bare specifier).
// Applied only to the reducer output — the gui keeps its bare specifiers for the importmap.
// Both bundlers externalize the SDK as a bare specifier (esbuild can rewrite in-resolve but
// Bun keeps the original specifier for externals, so a post-build rewrite is the one path
// that works for both).
export function sentinelizeReducer(js: string): string {
	return rewriteImports(js, (spec) => (SDK_SPECS.has(spec) ? SDK_SENTINEL + spec : undefined))
}

// Rewrite each `justfiles-sdk:<spec>` import in a compiled REDUCER bundle to a module URL
// the worker can actually load — the spawn-side inverse of `sentinelizeReducer`. All three
// channels (built-in, installed, devkit preview) reach `GetSandbox`, so this is the ONE
// seam where the sentinel becomes a real URL. `resolve` is host-supplied — only the host
// knows its runtime + how it exposes the SDK:
//   browser  → `${location.origin}/vendor/<spec>.js`  (served; the blob worker fetches it)
//   node/bun → moduleUrl(hostSdkSource[spec])          (data:/blob: of the in-memory SDK)
// Call it INSIDE spawn, AFTER the content-address key is taken over `code`, so a `blob:`
// URL's random UUID never enters the cache key (else a byte-identical app never hits). We
// resolve ONLY specs on the SDK allowlist (`isSdkSpec`) — our compiler sentinelizes only
// those, so an untrusted bundle's bogus `justfiles-sdk:<anything>` is left untouched (it
// fails to load cleanly, and can never be coerced into an arbitrary `/vendor/...` fetch URL).
export function resolveSdkExternals(code: string, resolve: (spec: string) => string): string {
	return rewriteImports(code, (spec) => {
		if (!spec.startsWith(SDK_SENTINEL)) return undefined
		const bare = spec.slice(SDK_SENTINEL.length)
		return SDK_SPECS.has(bare) ? resolve(bare) : undefined
	})
}

// The `/vendor/<spec>.js` URL a specifier resolves to (importmap value + the reducer's
// served-URL form). React keeps its existing mangled vendor names, so this is the SDK
// half of the importmap; callers merge it with the React entries.
export function vendorUrl(spec: string): string {
	return `/vendor/${spec}.js`
}
