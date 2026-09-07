import { Container } from '@cloudflare/containers'

export class CodexProxy extends Container {
	defaultPort = 8080
	sleepAfter = '2m'
}

export default {
	async fetch(
		request: Request,
		env: { POC_KEY: string; PROXY: DurableObjectNamespace<CodexProxy> }
	): Promise<Response> {
		if (!env.POC_KEY || request.headers.get('x-poc-key') !== env.POC_KEY) {
			return new Response('Unauthorized', { status: 401 })
		}
		return env.PROXY.getByName('poc').fetch(request)
	}
}
