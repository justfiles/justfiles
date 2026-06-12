// Host side of the `agentSetup` capability — the trust boundary for AI auth.
// Acquiring a ChatGPT token needs a browser + a loopback listener, which the
// sandboxed reducer/webview can't do, so it runs here in the daemon. The heavy
// lifting (PKCE, the 127.0.0.1:1455 catcher, token exchange, refresh, and the
// `chatgpt-account-id` request header) is all `@mariozechner/pi-ai` — the same
// "Sign in with ChatGPT" flow Codex uses — so this file is just glue: run the
// flow, write the Volume file, project the model list.

import { execFile } from 'node:child_process'
import { implementCapability } from '@justfiles/app/capabilities'
import { agentSetup } from '@justfiles/app/capabilities/agent-setup'
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

export const agentSetupCapability = (fs: Volume) =>
	implementCapability(agentSetup, {
		status: async () => {
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
		signIn: async (_ctx, { provider }) => {
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
		selectModel: async (_ctx, { model }) => {
			const conn = await readChatgpt(fs)
			if (!conn) throw new Error('not connected')
			await writeChatgpt(fs, { ...conn, model })
		},
		signOut: async () => {
			await clearChatgpt(fs)
		}
	})
