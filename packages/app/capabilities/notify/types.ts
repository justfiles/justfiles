// The portable notification shape — one type shared by the agent, the `notify`
// capability, and every host channel. A notification is a TRANSIENT projection (a
// ping over a platform-specific channel), not a store: case-1 durability already
// lives in the agent transcript. Grown per slice (CLAUDE.md): Phase 2 adds
// `durable?`, `scheduledAt?`, `actions[]` — not before their slice.

export interface Notification {
	id: string
	// Who produced it: 'agent' | <appId> | 'system'. The kernel STAMPS this for
	// sandboxed apps (an app can't spoof another's identity); trusted producers
	// (agent, cron) set it directly. Click-routing keys off it.
	source: string
	kind: 'info' | 'error' | 'question' // grows: 'progress' | 'reminder' (Phase 2)
	title: string
	body: string
	// Coalesce/replace key → the channel's native dedup id (macOS request
	// identifier; web Notification `tag`), so a re-post under the same thread
	// replaces the previous banner instead of stacking.
	threadId?: string
	route?: Route // where a click goes
}

export type Route =
	| { kind: 'chat' } // summon the host's chat surface
	| { kind: 'app'; id: string } // open a mini-app
	| { kind: 'settings'; pane?: string } // e.g. accounts → reconnect

// A host channel: it projects a notification onto its platform — the Mac host broadcasts
// to its launcher sockets (→ UNUserNotificationCenter); frieren pushes to the
// browser (web push / in-tab toast). Everything portable lives ABOVE it; the
// channel is the one per-host piece.
export type Channel = (notification: Notification) => void
