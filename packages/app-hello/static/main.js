// Hello app — new ESM contract. The host shell `import()`s this module,
// reads the default export, and calls `mount(el, host)`.
//
// `defineApp` is a tiny identity helper that lives canonically in
// `@justfiles/app`. It is inlined here to keep this slice's `app-hello`
// build-free; later slices set up a real bundler for apps that have
// imports beyond the host SDK.
const defineApp = (app) => app

export default defineApp({
	id: 'hello',
	mount(el, host) {
		const root = document.createElement('main')
		root.className = 'app-hello'
		root.innerHTML = `
			<style>
				.app-hello { height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1rem; padding: 2rem; text-align: center; background: #0b1220; color: #e6f0ff; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
				.app-hello h1 { font-size: clamp(2rem, 6vw, 3.5rem); margin: 0; letter-spacing: 0.02em; }
				.app-hello p { max-width: 32rem; margin: 0; color: #a8c6ff; line-height: 1.5; }
				.app-hello [data-id="time"] { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #79ffd6; }
				.app-hello [data-id="status"] { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.85rem; padding: 0.25rem 0.6rem; border: 1px solid #334155; border-radius: 999px; color: #022c22; background: #79ffd6; }
			</style>
			<h1>Hello, world.</h1>
			<p>This page is loaded as a remote ESM module — no iframe, no postMessage.</p>
			<p data-id="time"></p>
			<p data-id="status">started · host sdk v${host.version}</p>
		`
		el.append(root)
		this._root = root
		this._tick = () => {
			const node = root.querySelector('[data-id="time"]')
			if (node) node.textContent = new Date().toLocaleTimeString()
		}
		this._tick()
		this._interval = setInterval(this._tick, 1000)
	},
	unmount() {
		clearInterval(this._interval)
		this._root?.remove()
		this._root = null
	}
})
