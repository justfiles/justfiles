import { createServer } from 'node:http'
import { request } from 'node:https'
import { pipeline } from 'node:stream'

createServer((incoming, outgoing) => {
	if (incoming.url === '/health' && incoming.method === 'GET') {
		outgoing.setHeader('content-type', 'application/json')
		outgoing.end(JSON.stringify({ runtime: process.version, platform: process.platform }))
		return
	}
	if (incoming.url !== '/codex/responses' || incoming.method !== 'POST') {
		outgoing.writeHead(404).end()
		return
	}
	const headers: Record<string, string | string[]> = {}
	for (const name of [
		'authorization',
		'chatgpt-account-id',
		'content-type',
		'content-encoding',
		'accept',
		'openai-beta',
		'originator',
		'user-agent',
		'session_id'
	]) {
		const value = incoming.headers[name]
		if (value) headers[name] = value
	}
	const upstream = request(
		'https://chatgpt.com/backend-api/codex/responses',
		{ method: 'POST', headers },
		(response) => {
			outgoing.writeHead(response.statusCode ?? 502, response.headers)
			outgoing.flushHeaders()
			pipeline(response, outgoing, () => {})
		}
	)
	upstream.on('error', () => {
		if (!outgoing.headersSent) outgoing.writeHead(502).end('Upstream connection failed')
		else outgoing.destroy()
	})
	upstream.setTimeout(120_000, () => upstream.destroy())
	outgoing.on('close', () => upstream.destroy())
	pipeline(incoming, upstream, () => {})
}).listen(8080, '0.0.0.0')
