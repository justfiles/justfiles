// The shared seam for ship-time launcher-asset bundling (build-assets.ts). One
// `bundleAsset` signature, two backends behind `#assets`: native esbuild under node,
// Bun.build under bun — the same runtime-selected split as `#engine`. Pure types here,
// no bundler import, so both siblings and the consumer share one contract.
//
// Two call shapes: `contents` bundles an inline source string (the React vendor core
// and the boot script — esbuild's stdin / a Bun virtual entry); `entry` bundles a file
// (the launcher chat, with React externalised to the importmap). Output is the bundled,
// minified ESM text.

export type AssetBundle = {
	resolveDir: string
	// Inline source to bundle (mutually exclusive with `entry`).
	contents?: string
	// Entry file to bundle (mutually exclusive with `contents`).
	entry?: string
	// Bare specifiers to leave unbundled (resolved by the shell importmap at load).
	external?: string[]
	// Transform JSX with the automatic runtime (the chat surface is .tsx).
	jsx?: boolean
}

export type BundleAsset = (opts: AssetBundle) => Promise<string>
