// The ChatGPT provider for the accounts model, plus the agent's token resolver.
// "Sign in with ChatGPT" needs a browser + a loopback listener (PKCE, the
// 127.0.0.1:1455 catcher, token exchange, refresh), which the sandboxed reducer
// can't do — so the oauth flow runs here in the daemon via `@mariozechner/pi-ai`,
// the same flow Codex uses. Everything else is glue: declare the provider, mint
// the `ai` use facet over the resolved token, and project the model picker.
//
// This replaces the bespoke connections.ts: an account now lives in the accounts
// store (a JSON file on the Volume) like any other provider, and the selected
// model rides as the `ai` capability's per-account config rather than a field on
// a chatgpt-only connection record.

import { execFile } from 'node:child_process'
import { text } from '@justfiles/agent'
import type { AccountsStore, Creds, Provider } from '@justfiles/app/capabilities/accounts/host'
import type { AiCapability } from '@justfiles/app/capabilities/ai'
import { getModels } from '@mariozechner/pi-ai'
import { loginOpenAICodex, refreshOpenAICodexToken } from '@mariozechner/pi-ai/oauth'

export const CHATGPT_PROVIDER_ID = 'chatgpt'

// The creds an account from this provider stores. Shaped to OAuthCredentials plus
// the account id pulled from the id_token.
interface ChatgptCreds extends Creds {
	access: string
	refresh: string
	expires: number
	accountId: string
}

// pi-ai ships the selectable models for the ChatGPT subscription; relay id/name to
// the picker. Default to Codex Max, falling back to the first.
function codexModels(): { id: string; name: string }[] {
	return getModels('openai-codex').map((m) => ({ id: m.id, name: m.name }))
}

function defaultModel(): string {
	const models = codexModels()
	return models.find((m) => m.id === 'gpt-5.1-codex-max')?.id ?? models[0]?.id ?? ''
}

function resolveModel(id: string | undefined) {
	const wanted = id ?? defaultModel()
	return getModels('openai-codex').find((m) => m.id === wanted)
}

export const chatgptProvider: Provider = {
	id: CHATGPT_PROVIDER_ID,
	name: 'ChatGPT',
	auth: {
		kind: 'oauth',
		signIn: async () => {
			const creds = await loginOpenAICodex({
				onAuth: ({ url }) => void execFile('open', [url], () => {}),
				// Manual-paste fallback isn't wired in the GUI yet; surface a clear
				// error if the loopback bind fails (e.g. port 1455 already in use).
				onPrompt: async () => {
					throw new Error('Could not open the browser sign-in (is port 1455 in use?)')
				}
			})
			const accountId = String(creds.accountId ?? '')
			return {
				accountId,
				creds: {
					access: creds.access,
					refresh: creds.refresh,
					expires: creds.expires,
					accountId
				} satisfies ChatgptCreds
			}
		}
	},
	mint: {
		// Build an `ai` use-facet impl over the token + selected model. No proactive
		// refresh here (mint has no store writeback); the agent keeps the stored token
		// fresh and a stale-token call simply 401s into a re-sign-in.
		ai: (creds, config) => {
			const model = resolveModel((config as { model?: string } | undefined)?.model)
			if (!model) throw new Error('no ChatGPT model available')
			const gen = text({ model, apiKey: (creds as ChatgptCreds).access })
			return {
				generateText: async ({ system, prompt }) => ({
					text: await gen.gen(typeof system === 'string' ? system : '', prompt)
				})
			} satisfies AiCapability
		}
	},
	describe: {
		// The model picker: the selected model (defaulted) + the full list to choose from.
		ai: (config) => ({
			model: (config as { model?: string } | undefined)?.model ?? defaultModel(),
			models: codexModels()
		})
	}
}

// Resolve the ai-enabled ChatGPT account for the agent's direct LLM runtime
// (the agent builds a full pi-agent runtime, not just text, so it reads the store
// rather than the `ai` use facet). Refreshes a near-expiry token (a plain POST, no
// browser) and writes the rotated creds back so the next host to sync gets them; a
// refresh failure falls through with the stale token (the request 401s → re-auth).
export async function resolveAi(
	store: AccountsStore
): Promise<{ access: string; model: string } | null> {
	const account = (await store.list()).find(
		(a) => a.providerId === CHATGPT_PROVIDER_ID && 'ai' in a.enabled
	)
	if (!account) return null
	let creds = account.creds as ChatgptCreds
	if (creds.expires - Date.now() < 60_000) {
		try {
			const r = await refreshOpenAICodexToken(creds.refresh)
			creds = {
				access: r.access,
				refresh: r.refresh,
				expires: r.expires,
				accountId: String(r.accountId ?? creds.accountId)
			}
			await store.put({ ...account, creds })
		} catch {
			// keep the stale token; the caller's request will 401 and prompt re-auth
		}
	}
	const config = account.enabled.ai as { model?: string } | undefined
	return { access: creds.access, model: config?.model ?? defaultModel() }
}
