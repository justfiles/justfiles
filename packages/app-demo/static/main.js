// App Demo — new ESM contract. Mirrors the legacy iframe demo's volume
// behaviour (write input, read it back) using the typed `host.volume.*`
// methods. Capability + agent demos are deferred to later refactor slices.
//
// `defineApp` is inlined to keep this app build-free, matching `app-hello`.
const defineApp = (app) => app

const STYLE = `
.app-demo { box-sizing: border-box; height: 100%; width: 100%; padding: 2rem; overflow: auto; background: #0b1220; color: #e6f0ff; font-family: Inter, ui-sans-serif, system-ui, sans-serif; display: grid; gap: 1rem; align-content: start; }
.app-demo h1, .app-demo h2, .app-demo p, .app-demo ol { margin: 0; }
.app-demo h1 { color: #79ffd6; }
.app-demo .lede, .app-demo section { max-width: 48rem; }
.app-demo section { padding: 1rem; border: 1px solid #26354f; border-radius: 0.75rem; background: #111a2e; }
.app-demo label { display: grid; gap: 0.35rem; font: inherit; }
.app-demo input { box-sizing: border-box; width: 100%; margin: 0.5rem 0; padding: 0.6rem; border: 1px solid #334155; border-radius: 0.5rem; color: inherit; background: #0f172a; font: inherit; }
.app-demo button { padding: 0.6rem 0.8rem; border: 0; border-radius: 0.5rem; color: #06111f; background: #79ffd6; cursor: pointer; font: inherit; }
.app-demo code, .app-demo strong, .app-demo [data-id="volume-last"] { color: #79ffd6; }
.app-demo ol { padding-left: 1.25rem; }
`

const MARKUP = `
<style>${STYLE}</style>
<main class="app-demo">
	<h1>App Demo</h1>
	<p class="lede">Vanilla module loaded by the host's ESM app loader. Uses the typed <code>host.volume</code> SDK directly.</p>

	<section>
		<h2>Lifecycle</h2>
		<p>SDK v<span data-id="sdk-version">?</span> · <strong data-id="lifecycle">started</strong></p>
	</section>

	<section>
		<h2>Volume</h2>
		<label>Value <input data-id="volume-value" value="hello from app-demo" /></label>
		<button data-id="volume-write" type="button">write + read</button>
		<p data-id="volume-last">not read yet</p>
	</section>

	<section>
		<h2>Author notes</h2>
		<ol>
			<li>Default-export <code>defineApp({ id, mount, unmount })</code>; render inside <code>mount</code>.</li>
			<li>Receive the typed <code>host</code> as a <code>mount(el, host)</code> argument.</li>
			<li>Persist app-private files with <code>host.volume.readText/writeText</code>.</li>
			<li>Failures throw real <code>Error</code> instances — branch with <code>try/catch</code>.</li>
		</ol>
	</section>
</main>
`

export default defineApp({
	id: 'demo',
	async mount(el, host) {
		el.innerHTML = MARKUP
		this._el = el

		const $ = (id) => el.querySelector(`[data-id="${id}"]`)
		const setText = (id, text) => {
			const node = $(id)
			if (node) node.textContent = text
		}

		setText('sdk-version', String(host.version))

		const refreshFromVolume = async () => {
			try {
				setText('volume-last', await host.volume.readText('demo.txt'))
			} catch (err) {
				setText('volume-last', err?.name === 'NotFoundError' ? 'first launch' : String(err))
			}
		}
		await refreshFromVolume()

		const onWrite = async () => {
			const input = $('volume-value')
			try {
				await host.volume.writeText('demo.txt', input.value)
				await refreshFromVolume()
			} catch (err) {
				setText('volume-last', String(err))
			}
		}
		const writeBtn = $('volume-write')
		writeBtn?.addEventListener('click', onWrite)
		this._cleanup = () => writeBtn?.removeEventListener('click', onWrite)
	},
	unmount() {
		this._cleanup?.()
		if (this._el) this._el.innerHTML = ''
		this._el = null
		this._cleanup = null
	}
})
