import { type Context, createModels, InMemoryCredentialStore, Type } from '@earendil-works/pi-ai'
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'

// Pi hides its OAuth imports from bundlers; this includes them in the Worker bundle.
registerBunOAuthFlows()

export default {
	fetch(request: Request, env: { POC_KEY: string; PROXY_URL?: string }): Response {
		const path = new URL(request.url).pathname
		if (path === '/' && request.method === 'GET') {
			return new Response(page, {
				headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
			})
		}
		if (path !== '/probe') return new Response('Not found', { status: 404 })
		if (!env.POC_KEY || request.headers.get('authorization') !== `Bearer ${env.POC_KEY}`) {
			return new Response('Unauthorized', { status: 401 })
		}
		if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 })

		const abort = new AbortController()
		const signal = AbortSignal.any([abort.signal, request.signal, AbortSignal.timeout(900_000)])
		const encoder = new TextEncoder()
		const body = new ReadableStream<Uint8Array>({
			async start(controller) {
				const emit = (event: Record<string, unknown>) => {
					signal.throwIfAborted()
					controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
				}
				const keepalive = setInterval(() => {
					if (!signal.aborted) emit({ type: 'heartbeat' })
				}, 15_000)
				try {
					await probe(emit, signal, env)
				} finally {
					clearInterval(keepalive)
					if (!abort.signal.aborted) controller.close()
				}
			},
			cancel() {
				abort.abort()
			}
		})
		return new Response(body, {
			headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' }
		})
	}
}

async function probe(
	emit: (event: Record<string, unknown>) => void,
	signal: AbortSignal,
	env: { POC_KEY: string; PROXY_URL?: string }
) {
	const credentials = new InMemoryCredentialStore()
	const models = createModels({ credentials })
	const provider = openaiCodexProvider()
	models.setProvider(provider)
	let stage = 'device_login'
	try {
		if (env.PROXY_URL) {
			stage = 'proxy_transport'
			emit({ type: 'stage', stage })
			const response = await fetch(`${env.PROXY_URL}/codex/responses`, {
				method: 'POST',
				headers: {
					'x-poc-key': env.POC_KEY,
					authorization: 'Bearer deliberately-invalid-token',
					'content-type': 'application/json'
				},
				body: '{}',
				signal
			})
			const contentType = response.headers.get('content-type')
			await response.body?.cancel()
			emit({ type: 'upstream', stage, status: response.status, contentType })
			if (response.status !== 401 || !contentType?.includes('application/json')) {
				throw new Error(`Proxy transport HTTP ${response.status}`)
			}
			emit({ type: 'passed', stage })
		}
		stage = 'device_login'
		emit({ type: 'stage', stage })
		await models.login(provider.id, 'oauth', {
			signal,
			prompt: async (prompt) => {
				if (prompt.type === 'select') return 'device_code'
				throw new Error('Unexpected login prompt')
			},
			notify: (event) => {
				if (event.type === 'device_code') emit({ ...event })
			}
		})
		emit({ type: 'passed', stage })

		const original = models.getModel(provider.id, 'gpt-5.4-mini')
		if (!original) throw new Error('Probe model unavailable')
		const model = env.PROXY_URL ? { ...original, baseUrl: env.PROXY_URL } : original
		emit({ type: 'model', id: model.id, transport: 'sse', proxy: Boolean(env.PROXY_URL) })
		const context: Context = {
			systemPrompt: 'You are testing a tool integration. Follow the user instructions exactly.',
			messages: [
				{
					role: 'user',
					content: 'Call read_probe_code once, then reply with only the exact code it returns.',
					timestamp: Date.now()
				}
			],
			tools: [
				{
					name: 'read_probe_code',
					description: 'Read the random code held by this Cloudflare Worker.',
					parameters: Type.Object({})
				}
			]
		}
		const run = async (input: Context) => {
			const stream = models.streamSimple(model, input, {
				headers: env.PROXY_URL ? { 'x-poc-key': env.POC_KEY } : undefined,
				transport: 'sse',
				reasoning: 'minimal',
				maxTokens: 1024,
				onResponse: ({ status, headers }) => {
					emit({
						type: 'upstream',
						stage,
						status,
						contentType: headers['content-type'],
						mitigated: headers['cf-mitigated']
					})
				},
				signal
			})
			for await (const event of stream) {
				if (event.type === 'text_delta') emit({ type: 'text', stage, text: event.delta })
			}
			const result = await stream.result()
			if (result.stopReason === 'error' || result.stopReason === 'aborted') {
				throw new Error(result.errorMessage ?? 'Inference failed')
			}
			emit({ type: 'usage', stage, tokens: result.usage.totalTokens })
			return result
		}

		stage = 'tool_call'
		emit({ type: 'stage', stage })
		const first = await run(context)
		const calls = first.content.filter((part) => part.type === 'toolCall')
		const call = calls[0]
		if (calls.length !== 1 || call?.name !== 'read_probe_code') {
			throw new Error('Expected one read_probe_code call')
		}
		const code = crypto.randomUUID()
		emit({ type: 'passed', stage, tool: call.name })
		context.messages.push(first, {
			role: 'toolResult',
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: 'text', text: code }],
			isError: false,
			timestamp: Date.now()
		})
		stage = 'tool_result'
		const second = await run(context)
		const reply = second.content
			.flatMap((part) => (part.type === 'text' ? [part.text] : []))
			.join('')
		if (reply.trim() !== code) throw new Error('Tool result did not match')
		emit({ type: 'passed', stage })

		stage = 'token_refresh'
		emit({ type: 'stage', stage })
		// Expire only our in-memory copy to exercise Pi's normal refresh and writeback.
		await credentials.modify(provider.id, async (current) =>
			current?.type === 'oauth' ? { ...current, expires: 0 } : undefined
		)
		await models.getAuth(provider.id)
		const refreshed = await credentials.read(provider.id)
		if (refreshed?.type !== 'oauth' || refreshed.expires <= Date.now()) {
			throw new Error('Refresh did not update the credential')
		}
		emit({ type: 'passed', stage })
		stage = 'inference_after_refresh'
		const third = await run({
			messages: [{ role: 'user', content: 'Reply exactly REFRESH_OK', timestamp: Date.now() }]
		})
		const text = third.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
		if (text.trim() !== 'REFRESH_OK') throw new Error('Unexpected reply after refresh')
		emit({ type: 'passed', stage })
		emit({ type: 'complete', ok: true })
	} catch (error) {
		if (!signal.aborted) {
			// Provider errors may contain token response bodies. Emit only status and stage.
			const message = error instanceof Error ? error.message : ''
			const status = message.match(/(?:status|failed|HTTP)[^\d]{0,12}(\d{3})/i)?.[1]
			emit({
				type: 'complete',
				ok: false,
				stage,
				status: status ? Number(status) : null,
				html: /<html[\s>]/i.test(message)
			})
		}
	} finally {
		await models.logout(provider.id)
	}
}

const page = `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Frieren · Codex subscription POC</title>
<style>
body { max-width: 720px; margin: 64px auto; padding: 0 24px; font: 16px/1.6 system-ui; color: #242424; }
button { padding: 10px 18px; cursor: pointer; } pre { white-space: pre-wrap; overflow-wrap: anywhere; }
code { font-size: 24px; } #login { padding: 20px; background: #f3f3f3; margin: 24px 0; }
</style>
<h1>Frieren · Codex subscription POC</h1>
<p>Test your ChatGPT subscription with device login, a tool call, and token refresh.
This runs three short model requests. Authentication and tools run in the Worker;
inference goes through a Node.js container proxy. Credentials stay in request memory
and are discarded afterward.</p>
<p>Enable device-code login in your ChatGPT security settings first.</p>
<button id="start">Connect ChatGPT and run test</button> <button id="stop" disabled>Cancel</button>
<section id="login" hidden><p>Open <a id="link" target="_blank" rel="noreferrer">OpenAI sign-in</a> and enter:</p><code id="code"></code></section>
<pre id="log" role="status"></pre>
<script>
const key = location.hash.slice(1)
history.replaceState(null, '', location.pathname)
const start = document.querySelector('#start')
const stop = document.querySelector('#stop')
const log = document.querySelector('#log')
let abort
if (!key) { start.disabled = true; log.textContent = 'Open the private test link to begin.' }
start.onclick = async () => {
	start.disabled = true; stop.disabled = false; log.textContent = ''
	abort = new AbortController()
	try {
		const response = await fetch('/probe', { method: 'POST', headers: { authorization: 'Bearer ' + key }, signal: abort.signal })
		if (!response.ok) throw new Error('HTTP ' + response.status)
		const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
		let pending = ''
		for (;;) {
			const { value, done } = await reader.read()
			if (done) break
			pending += value
			let end
			while ((end = pending.indexOf('\\n')) !== -1) {
				const event = JSON.parse(pending.slice(0, end)); pending = pending.slice(end + 1)
				log.textContent += JSON.stringify(event) + '\\n'
				if (event.type === 'device_code') {
					document.querySelector('#login').hidden = false
					document.querySelector('#link').href = event.verificationUri
					document.querySelector('#code').textContent = event.userCode
				}
			}
		}
	} catch (error) { log.textContent += error.message + '\\n' }
	finally { start.disabled = false; stop.disabled = true; document.querySelector('#login').hidden = true }
}
stop.onclick = () => abort.abort()
</script></html>`
