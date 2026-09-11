// Bun loads raw prompts and API references at runtime; the build uses its text plugin.
declare module '*?raw' {
	const content: string
	export default content
}
