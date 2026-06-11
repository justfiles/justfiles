// `@justfiles/agent` imports its markdown prompts as strings via the `?raw` suffix.
// quay consumes that source un-bundled, so this ambient declaration gives the shape
// for typecheck; `rawLoader.mjs` supplies the value at runtime.
declare module '*.md?raw' {
	const content: string
	export default content
}
