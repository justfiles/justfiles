import {
	type Credential,
	type CredentialStore,
	createModels,
	type OAuthCredential
} from '@earendil-works/pi-ai'
import { registerBunOAuthFlows } from '@earendil-works/pi-ai/bun-oauth'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { type AgentBackend, modelsBackend, text } from '@justfiles/agent'
import type { AiAccountLease } from '@justfiles/app/capabilities/accounts/host'
import type { BoundAccount, Provider } from '@justfiles/app/capabilities/accounts/providers'

registerBunOAuthFlows()

const codex = openaiCodexProvider()
const choices = codex.getModels().filter((model) => !['gpt-5.4', 'gpt-5.4-mini'].includes(model.id))
const defaultModel = 'gpt-5.6-luna'

export function chatgptAccount(proxy: { url: string; key: string }) {
	const oauth = codex.auth.oauth
	if (!oauth) throw new Error('Codex OAuth is unavailable')
	const auth = { oauth: { ...oauth, refresh } }
	const provider: Provider = {
		id: 'chatgpt',
		name: 'ChatGPT',
		auth: {
			ui: { kind: 'interactive' },
			acquire: async ({ signal, notify }) => {
				if (!notify) throw new Error('Start ChatGPT sign-in from Settings.')
				const creds = await oauth.login({
					signal,
					prompt: async (prompt) => {
						if (prompt.type !== 'select') throw new Error('Unexpected login prompt')
						return 'device_code'
					},
					notify: (event) => {
						if (event.type === 'device_code')
							notify({
								verificationUrl: event.verificationUri,
								userCode: event.userCode,
								intervalMs: (event.intervalSeconds ?? 5) * 1000
							})
					}
				})
				if (typeof creds.accountId !== 'string' || !creds.accountId)
					throw new Error('Missing account identity')
				return { accountId: `chatgpt:${creds.accountId}`, creds }
			}
		},
		capabilities: {
			ai: {
				models: () => choices.map(({ id, name }) => ({ id, name })),
				defaultModel: () => defaultModel,
				bind: (account) => ({
					generateText: async ({ system, prompt }) => ({
						text: await text(backend(account)).gen(system ?? '', prompt)
					})
				})
			}
		}
	}

	function backend(account: BoundAccount, revision = ''): AgentBackend {
		const id = (account.config as { model?: string } | undefined)?.model ?? defaultModel
		const original = choices.find((model) => model.id === id)
		if (!original)
			throw new Error('This ChatGPT model is unavailable. Choose another model in Settings.')
		const credentials: CredentialStore = {
			read: async () => (await account.credentials.read()) as Credential,
			modify: (_id, change) =>
				account.credentials.modify((current) => change(current as Credential)) as Promise<
					Credential | undefined
				>,
			list: async () => [{ providerId: codex.id, type: 'oauth' }],
			delete: async () => {
				throw new Error('Disconnect the account through Settings.')
			}
		}
		const models = createModels({ credentials })
		// Pi's current refresh implementation ignores AbortSignal. Bound the actual
		// request so a failed token endpoint cannot hold this account's lock forever.
		models.setProvider({ ...codex, auth })
		const base = modelsBackend(models, { ...original, baseUrl: proxy.url }, revision)
		const options = (input: Parameters<typeof models.streamSimple>[2]) => ({
			...input,
			transport: 'sse' as const,
			maxRetries: 0,
			headers: { 'x-proxy-key': proxy.key }
		})
		return {
			...base,
			streamFn: (model, context, input) => models.streamSimple(model, context, options(input)),
			completeFn: (model, context, input) => models.completeSimple(model, context, options(input))
		}
	}

	return {
		provider,
		backend: (lease: AiAccountLease) => backend(lease, `${lease.accountId}:${lease.revision}`)
	}
}

async function refresh(
	credential: OAuthCredential,
	signal?: AbortSignal
): Promise<OAuthCredential> {
	const timeout = AbortSignal.timeout(30_000)
	const response = await fetch('https://auth.openai.com/oauth/token', {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: credential.refresh,
			client_id: 'app_EMoamEEZ73f0CkXaXp7hrann'
		}),
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout
	})
	if (!response.ok)
		throw new Error(
			response.status === 400 || response.status === 401
				? 'ChatGPT needs a fresh sign-in. Reconnect it in Settings.'
				: 'ChatGPT sign-in service is unavailable. Please retry shortly.'
		)
	const token = (await response.json()) as {
		access_token?: string
		refresh_token?: string
		expires_in?: number
	}
	if (
		typeof token.access_token !== 'string' ||
		!token.access_token ||
		typeof token.refresh_token !== 'string' ||
		!token.refresh_token ||
		typeof token.expires_in !== 'number' ||
		!Number.isFinite(token.expires_in) ||
		token.expires_in <= 0
	)
		throw new Error('ChatGPT returned an invalid credential. Reconnect it in Settings.')
	return {
		...credential,
		access: token.access_token,
		refresh: token.refresh_token,
		expires: Date.now() + token.expires_in * 1000
	}
}
