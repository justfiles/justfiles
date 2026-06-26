// CSS imported as a string via `with { type: 'text' }` (Bun's text loader).
declare module '*.css' {
	const content: string
	export default content
}
