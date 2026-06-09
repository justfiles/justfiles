// The agent's system prompts are authored as markdown and imported as strings
// via the bundler's `?raw` suffix (vite / electron-vite). This ambient
// declaration lets the package typecheck standalone; hosts that bundle it get
// the same shape from `vite/client`.
declare module '*.md?raw' {
	const content: string
	export default content
}
