// Host side of the `ai` capability's ADMIN facet — the trust boundary for AI
// auth. Acquiring a ChatGPT token needs a browser + a loopback listener, which
// the sandboxed reducer/webview can't do, so it runs here in the daemon. The
// heavy lifting (PKCE, the 127.0.0.1:1455 catcher, token exchange, refresh, and
// the `chatgpt-account-id` request header) is all `@mariozechner/pi-ai` — the
// same "Sign in with ChatGPT" flow Codex uses — so this file is just glue: run
// the flow, write the Volume file, project the model list.
//
// Only the first-party Settings app may reach these methods: the daemon passes a
// `firstParty` allowlist and every call is gated on `ctx.appId`, mirroring the
// volume capability's `system`-scope allowlist. The companion USE facet
// (`ai.generateText`) is a separate unit any app may call — quay doesn't serve it
// at all, since its agent reads the resulting connection (connections.ts) directly.

import { execFile } from 'node:child_process'
import { CapabilityError, implementCapability } from '@justfiles/app/capabilities'
import { aiAdmin } from '@justfiles/app/capabilities/ai/admin'
import type { Volume } from '@justfiles/fs'
import { getModels } from '@mariozechner/pi-ai'
import { loginOpenAICodex } from '@mariozechner/pi-ai/oauth'
import { clearChatgpt, readChatgpt, writeChatgpt } from './connections.ts'

// pi-ai ships the selectable models for the ChatGPT subscription; we just relay
// their id/name to the picker. Default to Codex Max, falling back to the first.
function codexModels(): { id: string; name: string }[] {
	return getModels('openai-codex').map((m) => ({ id: m.id, name: m.name }))
}

function defaultModel(): string {
	const models = codexModels()
	return models.find((m) => m.id === 'gpt-5.1-codex-max')?.id ?? models[0]?.id ?? ''
}

export interface AiAdminOptions {
	// App ids permitted to reach the AI setup facet (the Settings app).
	firstParty?: Iterable<string>
}

export const aiAdminCapability = (fs: Volume, opts: AiAdminOptions = {}) => {
	const allow = new Set(opts.firstParty ?? [])
	// Every method here is privileged, so a single identity check covers them all.
	// Reported as UNAVAILABLE (not DENIED) so a non-first-party app can't even tell
	// the facet exists — same posture as the volume `system` allowlist.
	const guard = (ctx: { appId: string }) => {
		if (!allow.has(ctx.appId)) throw new CapabilityError('CAPABILITY_UNAVAILABLE', 'ai', 'admin')
	}
	return implementCapability(aiAdmin, {
		status: async (ctx) => {
			guard(ctx)
			const conn = await readChatgpt(fs)
			return conn
				? {
						connected: true,
						account: conn.oauth.accountId,
						model: conn.model,
						models: codexModels()
					}
				: { connected: false, models: [] }
		},
		signIn: async (ctx, { provider }) => {
			guard(ctx)
			if (provider !== 'chatgpt') throw new Error(`unknown provider: ${provider}`)
			const creds = await loginOpenAICodex({
				onAuth: ({ url }) => void execFile('open', [url], () => {}),
				// Manual-paste fallback isn't wired in the GUI yet; surface a clear
				// error if the loopback bind fails (e.g. port 1455 already in use).
				onPrompt: async () => {
					throw new Error('Could not open the browser sign-in (is port 1455 in use?)')
				}
			})
			await writeChatgpt(fs, {
				provider: 'chatgpt',
				oauth: {
					access: creds.access,
					refresh: creds.refresh,
					expires: creds.expires,
					accountId: String(creds.accountId ?? '')
				},
				model: defaultModel()
			})
		},
		selectModel: async (ctx, { model }) => {
			guard(ctx)
			const conn = await readChatgpt(fs)
			if (!conn) throw new Error('not connected')
			await writeChatgpt(fs, { ...conn, model })
		},
		signOut: async (ctx) => {
			guard(ctx)
			await clearChatgpt(fs)
		}
	})
}
