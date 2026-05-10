import './style.css'

type HostApp = Window['app']
type RpcLikeError = Error & { code?: number }

type DemoState = {
	lifecycle: 'booting' | 'started' | 'stopped'
	lastVolumeValue: string
	accent: string
	capabilityResult: string
	agentResult: string
	toolResult: string
}

const hostApp = (window as unknown as { app?: HostApp }).app
const state: DemoState = {
	lifecycle: 'booting',
	lastVolumeValue: 'not read yet',
	accent: '#79ffd6',
	capabilityResult: 'not called yet',
	agentResult: 'not sent yet',
	toolResult: 'registered; ask the agent to call demo_setAccent'
}

const privateDraft = 'private draft omitted from agent.describe()'

const setText = (id: string, text: string) => {
	const el = document.getElementById(id)
	if (el) el.textContent = text
}

const setState = (patch: Partial<DemoState>) => {
	Object.assign(state, patch)
	setText('lifecycle', state.lifecycle)
	setText('volume-last', state.lastVolumeValue)
	setText('capability-result', state.capabilityResult)
	setText('agent-result', state.agentResult)
	setText('tool-result', state.toolResult)
	document.documentElement.style.setProperty('--accent', state.accent)
}

const errorText = (err: unknown) => {
	const e = err as Partial<RpcLikeError>
	return e.code ? `${e.message} (${e.code})` : err instanceof Error ? err.message : String(err)
}

const root = document.querySelector<HTMLDivElement>('#app')
if (!root) throw new Error('missing #app')

root.innerHTML = `
	<h1>App Demo</h1>
	<p class="lede">Vanilla TypeScript + Vite app using the injected <code>window.app</code> SDK.</p>

	<section>
		<h2>Lifecycle</h2>
		<p>SDK v<span id="sdk-version">?</span> · <strong id="lifecycle">booting</strong></p>
	</section>

	<section>
		<h2>Volume</h2>
		<label>Value <input id="volume-value" value="hello from app-demo" /></label>
		<button id="volume-write" type="button">write + read</button>
		<p id="volume-last">not read yet</p>
	</section>

	<section>
		<h2>Capability</h2>
		<button id="calendar" type="button">call calendar.listToday()</button>
		<p id="capability-result">not called yet</p>
	</section>

	<section>
		<h2>Agent</h2>
		<textarea id="prompt" rows="3">Please summarize what this demo app can do.</textarea>
		<button id="send-agent" type="button">send prompt</button>
		<p id="agent-result">not sent yet</p>
	</section>

	<section>
		<h2>Client tool + describe()</h2>
		<p id="tool-result">registered; ask the agent to call demo_setAccent</p>
		<p>The agent description exposes lifecycle, volume, and accent only. Private draft stays private.</p>
	</section>

	<section>
		<h2>Author notes</h2>
		<ol>
			<li>Declare <code>public/manifest.json</code> with <code>entry</code> and permissions.</li>
			<li>Use <code>window.app.lifecycle</code> when the iframe starts or stops.</li>
			<li>Persist app-private files with <code>window.app.volume</code>.</li>
			<li>Call typed host integrations through <code>window.app.capabilities</code>.</li>
			<li>Use <code>window.app.agent</code> for prompts, safe descriptions, and client tools.</li>
		</ol>
	</section>
`

if (!hostApp) {
	setState({ lifecycle: 'stopped', agentResult: 'window.app was not injected by a host' })
} else {
	setText('sdk-version', String(hostApp.version))

	const setAccent = (input: unknown) => {
		const requested =
			typeof input === 'object' && input && 'color' in input && typeof input.color === 'string'
				? input.color
				: '#79ffd6'
		setState({ accent: requested, toolResult: `agent set accent to ${requested}` })
		return { accent: requested }
	}

	const unregisterTool = hostApp.agent.tools.register({
		name: 'demo_setAccent',
		description: 'Set the App Demo accent color. Handler runs inside the iframe.',
		schema: {
			type: 'object',
			properties: { color: { type: 'string', description: 'Any CSS color.' } },
			required: ['color']
		},
		handler: setAccent
	})

	hostApp.agent.describe(() =>
		[
			`App Demo lifecycle: ${state.lifecycle}.`,
			`Last volume value: ${state.lastVolumeValue}.`,
			`Current accent: ${state.accent}.`
		].join(' ')
	)

	hostApp.lifecycle.onStart(() => {
		setState({ lifecycle: 'started' })
		void hostApp.volume
			.readText('demo.txt')
			.then((text) => setState({ lastVolumeValue: text }))
			.catch((err) =>
				setState({
					lastVolumeValue: (err as RpcLikeError).code === -32001 ? 'first launch' : errorText(err)
				})
			)
	})

	hostApp.lifecycle.onStop(() => {
		unregisterTool()
		setState({ lifecycle: 'stopped', toolResult: 'unregistered on stop/reload' })
	})

	document.getElementById('volume-write')?.addEventListener('click', async () => {
		const input = document.getElementById('volume-value') as HTMLInputElement
		try {
			await hostApp.volume.writeText('demo.txt', input.value)
			setState({ lastVolumeValue: await hostApp.volume.readText('demo.txt') })
		} catch (err) {
			setState({ lastVolumeValue: errorText(err) })
		}
	})

	document.getElementById('calendar')?.addEventListener('click', async () => {
		try {
			const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
			const events = await hostApp.capabilities.calendar.listToday({ timezone })
			setState({ capabilityResult: `calendar returned ${events.length} event(s)` })
		} catch (err) {
			setState({ capabilityResult: errorText(err) })
		}
	})

	document.getElementById('send-agent')?.addEventListener('click', async () => {
		const prompt = document.getElementById('prompt') as HTMLTextAreaElement
		try {
			await hostApp.agent.send(prompt.value)
			setState({ agentResult: 'prompt sent to agent' })
		} catch (err) {
			setState({ agentResult: errorText(err) })
		}
	})

	void privateDraft
}
