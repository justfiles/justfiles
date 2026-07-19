// The one irreducible selection: which account (and model) is the active AI. ai is
// single-active, so this is a single pointer — not a per-capability table — the analog
// of pi-ai's "which model" selection or Composio's per-(user, toolkit) connected
// account. Stored as one small JSON on the Volume.

import type { Volume } from '@justfiles/fs'

export interface ActiveAi {
	accountId: string
	model?: string
}

export interface ActiveAiStore {
	get(): Promise<ActiveAi | null>
	set(value: ActiveAi | null): Promise<void>
}

const PATH = '/system/active-ai.json'
const enc = new TextEncoder()
const dec = new TextDecoder()

export function volumeActiveAi(fs: Volume): ActiveAiStore {
	return {
		get: async () => {
			try {
				return JSON.parse(dec.decode(await fs.readFile(PATH))) as ActiveAi | null
			} catch {
				return null
			}
		},
		set: async (value) => {
			await fs.mkdir('/system', { recursive: true })
			await fs.writeFile(PATH, enc.encode(JSON.stringify(value, null, 2)))
		}
	}
}
