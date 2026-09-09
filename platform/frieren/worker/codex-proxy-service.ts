import { Container } from '@cloudflare/containers'

export class CodexProxy extends Container {
	defaultPort = 8080
	sleepAfter = '2m'
}

export default {
	async fetch(
		request: Request,
		env: { PROXY_KEY: string; PROXY: DurableObjectNamespace<CodexProxy> }
	) {
		if (!env.PROXY_KEY || request.headers.get('x-proxy-key') !== env.PROXY_KEY)
			return new Response('Unauthorized', { status: 401 })
		return env.PROXY.getByName('shared').fetch(request)
	}
}
