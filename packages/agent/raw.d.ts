// Hosts load prompts and capability API references as text through the bundler.
declare module '*?raw' {
	const content: string
	export default content
}
