import type { SessionEntry } from '@justfiles/agent'
import type { AppManifest } from '@justfiles/app'
import type { Notification } from '@justfiles/app/capabilities/notify'
import type { CommandMeta, CommandResult } from './commands'

/** Messages the daemon sends to a `/system` WebSocket client. */
export type ServerMessage =
	| { type: 'apps'; apps: AppManifest[] }
	| { type: 'hello'; message: string; time: string; uptime: number }
	| { type: 'error'; message: string }
	// The slash-command catalogue (built-ins + skills) for the launcher's `/` menu, sent
	// on connect. Commands are a daemon concept — dispatched over this same socket.
	| { type: 'commands'; commands: CommandMeta[] }
	// A `notify`-capability or agent notification fanned out to every launcher; the
	// native sink (CatalogClient) projects it onto the OS banner.
	| { type: 'notification'; notification: Notification }
	// Reply to a `command` request: what the launcher should do (show chat / text / dismiss).
	| { type: 'commandResult'; id: string; result: CommandResult }

/** Messages a `/system` client sends to the daemon. */
export type ClientMessage = { type: 'command'; id: string; name: string }

// The `/agent` socket is a live view of the shared session: the daemon pushes the whole
// transcript on every change (no polling), plus a busy flag and turn errors. The chat only
// ever sends prompts — commands ride `/system`, skills reach the agent via `applySkill`.
export type AgentEvent =
	| { type: 'history'; entries: SessionEntry[] }
	| { type: 'busy'; value: boolean }
	| { type: 'error'; message: string }

/** Messages an `/agent` client sends to the daemon. */
export type AgentRequest = { type: 'prompt'; text: string } | { type: 'abort' }
