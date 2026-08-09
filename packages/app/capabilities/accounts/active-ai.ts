// The one irreducible selection: which account (and model) is the active AI. ai is
// single-active, so this is a single pointer — not a per-capability table — the analog
// of pi-ai's "which model" selection or Composio's per-(user, toolkit) connected
// account. Stored as one small JSON on the Volume.
//
// HOST-PRIVATE, next to the accounts it names (`/private`, never replicated in either
// direction). It is a reference to a host-only record, so it only means anything on the
// host that holds that record. In the synced `/system` lane the same pointer was two bugs
// at once: it outlived accounts that were never here (another host's, or a retired id) and
// resolved to no backend at all; and two hosts fought over one slot — each boot claiming
// its own default would sync back and deselect the other's working provider. What is
// portable about "I prefer my own ChatGPT" is a PREFERENCE (a provider, a model), which is
// not this: this is a pointer into one host's credential store.

import type { Volume } from '@justfiles/fs'

export interface ActiveAi {
	accountId: string
	model?: string
}

export interface ActiveAiStore {
	// `null` = nothing is selected, which is not the same as "no AI": an absent selection
	// resolves to the host's built-in platform AI (see host.ts). No file is written to say so.
	get(): Promise<ActiveAi | null>
	// `null` REMOVES the pointer rather than storing a null: "the user chose nothing" and
	// "the user chose the floor" have to be one state, or a wipe would leave a file behind
	// that says something the derived default already says.
	set(value: ActiveAi | null): Promise<void>
}

const DIR = '/private'
const PATH = `${DIR}/active-ai.json`
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
			if (value === null) {
				await fs.rm(PATH, { force: true })
				return
			}
			await fs.mkdir(DIR, { recursive: true })
			await fs.writeFile(PATH, enc.encode(JSON.stringify(value, null, 2)))
		}
	}
}
