// The one place a connection lives: a plaintext JSON file on the Volume. A
// connection is data, not code — so it rides the same syncable substrate
// everything else does (`/system`, where the agent keeps soul.md). Acquiring the
// ChatGPT token needs a browser + loopback (aiAdmin.ts, quay-only); *using*
// and *refreshing* it are plain HTTPS that work anywhere, so once this file
// syncs to frieren the cloud host drives the same subscription with no browser.
//
// v1 stores one provider, ChatGPT, under the DESIGN's per-account layout so
// multi-account/multi-provider need no shape change — just more files.

import type { Volume } from '@justfiles/fs'
import { refreshOpenAICodexToken } from '@mariozechner/pi-ai/oauth'

const CHATGPT_PATH = '/system/connections/chatgpt/default.json'

export interface ChatgptConnection {
	provider: 'chatgpt'
	oauth: { access: string; refresh: string; expires: number; accountId: string }
	// The model id the agent should drive (one of getModels('openai-codex')).
	model: string
}

const dec = new TextDecoder()
const enc = new TextEncoder()

export async function readChatgpt(fs: Volume): Promise<ChatgptConnection | null> {
	if (!(await fs.exists(CHATGPT_PATH))) return null
	try {
		return JSON.parse(dec.decode(await fs.readFile(CHATGPT_PATH))) as ChatgptConnection
	} catch {
		return null
	}
}

export async function writeChatgpt(fs: Volume, conn: ChatgptConnection): Promise<void> {
	await fs.mkdir('/system/connections/chatgpt', { recursive: true })
	await fs.writeFile(CHATGPT_PATH, enc.encode(JSON.stringify(conn, null, 2)))
}

export async function clearChatgpt(fs: Volume): Promise<void> {
	await fs.rm(CHATGPT_PATH, { force: true })
}

// Read the connection and hand back a *fresh* access token + the chosen model.
// Refreshes proactively when the token is within a minute of expiry (a plain
// POST, no browser) and writes the rotated tokens back so the next host to sync
// gets them. A refresh failure falls through with the stale token; the request
// will 401 and the user re-signs-in.
export async function resolveChatgpt(
	fs: Volume
): Promise<{ access: string; model: string } | null> {
	const conn = await readChatgpt(fs)
	if (!conn) return null
	let oauth = conn.oauth
	if (oauth.expires - Date.now() < 60_000) {
		try {
			const r = await refreshOpenAICodexToken(oauth.refresh)
			oauth = {
				access: r.access,
				refresh: r.refresh,
				expires: r.expires,
				accountId: String(r.accountId ?? oauth.accountId)
			}
			await writeChatgpt(fs, { ...conn, oauth })
		} catch {
			// keep the stale token; the caller's request will 401 and prompt re-auth
		}
	}
	return { access: oauth.access, model: conn.model }
}
