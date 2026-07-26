// `@justfiles/agent` imports its markdown prompts as strings via the `?raw` suffix.
// The daemon consumes that source un-bundled, so this ambient declaration gives the shape
// for typecheck; Bun supplies the value at runtime (and the ship-time `Bun.build` a
// text-loader plugin).
declare module '*.md?raw' {
	const content: string
	export default content
}
