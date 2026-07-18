// The ChatGPT provider for the accounts model, plus the agent's token resolver.
// "Sign in with ChatGPT" needs a browser + a loopback listener (PKCE, the
// 127.0.0.1:1455 catcher, token exchange, refresh), which the sandboxed reducer
// can't do — so the flow runs here in the daemon, driven by pi-ai's own `openai-codex`
// provider: its `OAuthAuth` owns login + refresh, and its catalogue owns the model
// list. Everything else is glue — run the provider's login, and mint the `ai` facet +
// the agent backend over a pi `Models` collection.
//
// An account lives in the accounts store (a JSON file on the Volume) like any other
// provider; the selected model rides as the `ai` capability's per-account config.

import { execFile } from 'node:child_process'
import {
	type Credential,
	type CredentialStore,
	createModels,
	type Models,
	type OAuthCredential
} from '@earendil-works/pi-ai'
import { openaiCodexProvider } from '@earendil-works/pi-ai/providers/openai-codex'
import { type AgentBackend, modelsBackend, text } from '@justfiles/agent'
import { type Creds, resolveAiAccount } from '@justfiles/app/capabilities/accounts/host'
import type { OAuthSignIn } from '@justfiles/app/capabilities/accounts/providers'
import type { AiCapability } from '@justfiles/app/capabilities/ai'
import type { Volume } from '@justfiles/fs'

// pi-ai's built-in Codex provider owns the model catalogue, the OAuth login flow, and
// token refresh. Registered on a Models collection per credential source; safe to share
// (it holds no per-collection state — Models supplies auth into each request).
const codexProvider = openaiCodexProvider()

// Relay the provider's catalogue to the picker. Default to Codex Max, else the first.
export function codexModels(): { id: string; name: string }[] {
	return codexProvider.getModels().map((m) => ({ id: m.id, name: m.name }))
}

export function defaultModel(): string {
	const models = codexModels()
	return models.find((m) => m.id === 'gpt-5.1-codex-max')?.id ?? models[0]?.id ?? ''
}

// A Models collection over one credential source, with Codex registered.
// `streamSimple`/`completeSimple` resolve auth and refresh the OAuth token internally,
// under the credential store's lock — no hand-rolled refresh here.
function codexRuntime(credentials: CredentialStore): Models {
	const models = createModels({ credentials })
	models.setProvider(codexProvider)
	return models
}

function pickModel(models: Models, id: string | undefined) {
	return (
		models.getModel('openai-codex', id ?? defaultModel()) ?? models.getModels('openai-codex')[0]
	)
}

// A single-credential CredentialStore over an account's creds plus its writeback:
// Models reads/refreshes through it, and `modify` persists a rotated token so the next
// host to sync gets it. Legacy creds without a `type` tag are coerced to `oauth`.
function accountCredentials(
	creds: Creds,
	persist: (creds: Creds) => Promise<void>
): CredentialStore {
	let current: Credential = { ...(creds as unknown as OAuthCredential), type: 'oauth' }
	return {
		read: async () => current,
		list: async () => [{ providerId: 'openai-codex', type: 'oauth' }],
		modify: async (_providerId, fn) => {
			const next = await fn(current)
			if (next) {
				current = next
				await persist(next as unknown as Creds)
			}
			return next
		},
		delete: async () => {}
	}
}

// OAuth acquisition (host-specific): run pi-ai's Codex login flow — it emits the consent
// URL (we shell out to `open`) and catches the loopback redirect. Returns the credential
// for the accounts store to persist; injected into `chatgptProvider` as its `signIn`.
export const chatgptSignIn: OAuthSignIn = async () => {
	const oauth = codexProvider.auth.oauth
	if (!oauth) throw new Error('Codex provider exposes no OAuth flow')
	const cred = await oauth.login({
		notify: (event) => {
			if (event.type === 'auth_url') void execFile('open', [event.url], () => {})
		},
		// Manual-paste fallback isn't wired in the GUI yet; surface a clear error if the
		// loopback bind fails (e.g. port 1455 already in use).
		prompt: async () => {
			throw new Error('Could not open the browser sign-in (is port 1455 in use?)')
		}
	})
	const accountId = String(cred.accountId ?? '')
	return { accountId, creds: { ...cred, accountId } satisfies Creds }
}

// Build an `ai` use-facet impl over the account's creds + selected model, streamed
// through pi Models. `mint` has no store writeback (the no-op persist), so a rotated
// token isn't saved here — a stale token simply 401s into re-sign-in.
export const chatgptMintAi = (creds: Creds, config: unknown): AiCapability => {
	const models = codexRuntime(accountCredentials(creds, async () => {}))
	const model = pickModel(models, (config as { model?: string } | undefined)?.model)
	if (!model) throw new Error('no ChatGPT model available')
	const gen = text(modelsBackend(models, model))
	return {
		generateText: async ({ system, prompt }) => ({
			text: await gen.gen(typeof system === 'string' ? system : '', prompt)
		})
	}
}

// Resolve the ai-enabled account into a backend for the daemon's agent runtime.
// `resolveAiAccount` borrows the account from the internal store; spud never holds the
// store or the creds outside this closure. The token is sealed inside pi Models (which
// refreshes it under its credential-store lock and `persist`s the rotated creds); the
// agent drives the model but never holds the credential.
export function resolveAgentBackend(fs: Volume): Promise<AgentBackend | null> {
	return resolveAiAccount(fs, ({ creds, config, persist }) => {
		const models = codexRuntime(accountCredentials(creds, persist))
		const model = pickModel(models, (config as { model?: string } | undefined)?.model)
		return model ? modelsBackend(models, model) : null
	})
}
