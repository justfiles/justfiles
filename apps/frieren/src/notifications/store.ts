import type { Notification } from '@justfiles/app/capabilities/notify'

export type { Notification, Route } from '@justfiles/app/capabilities/notify'

// A center entry: the portable Notification plus the two bits of local lifecycle
// the pill + center need. `dismissed` — it no longer owns the pill (auto after the
// info lifetime, or when acted on). `seen` — the user has opened the center since
// it arrived, so it no longer counts toward the unread bell-badge.
export interface NotificationEntry {
	notification: Notification
	at: number
	dismissed: boolean
	seen: boolean
}

// One immutable snapshot for `useSyncExternalStore`. `active` is what the pill
// shows (most-urgent-then-newest, undismissed); `queued` is the "+N" behind it;
// `unread` drives the bell-badge (history you haven't opened the center for —
// the active banner is excluded, since it's already in your face).
export interface NotificationSnapshot {
	entries: NotificationEntry[]
	active: NotificationEntry | null
	queued: number
	unread: number
}

export interface NotificationStore {
	notify(notification: Notification): void
	dismiss(id: string): void
	markSeen(): void
	clear(): void
	subscribe(listener: () => void): () => void
	snapshot(): NotificationSnapshot
}

// Ring-buffer cap: the center is a lightweight log, not an archive.
const MAX_ENTRIES = 50

// Urgency ordering for the single pill slot. error > question > info; ties break
// on recency (freedesktop `urgency`).
const RANK: Record<Notification['kind'], number> = { error: 3, question: 2, info: 1 }

function pickActive(entries: NotificationEntry[]): NotificationEntry | null {
	let best: NotificationEntry | null = null
	for (const entry of entries) {
		if (entry.dismissed) continue
		if (!best) {
			best = entry
			continue
		}
		const delta = RANK[entry.notification.kind] - RANK[best.notification.kind]
		// entries are newest-last, so `>= 0` on a rank tie keeps the newest.
		if (delta > 0 || (delta === 0 && entry.at >= best.at)) best = entry
	}
	return best
}

export function createNotificationStore(): NotificationStore {
	let entries: NotificationEntry[] = []
	const listeners = new Set<() => void>()
	let cached: NotificationSnapshot = build()

	function build(): NotificationSnapshot {
		const active = pickActive(entries)
		const undismissed = entries.reduce((n, e) => n + (e.dismissed ? 0 : 1), 0)
		const unread = entries.reduce((n, e) => n + (!e.seen && e !== active ? 1 : 0), 0)
		return { entries, active, queued: active ? undismissed - 1 : 0, unread }
	}

	function emit(): void {
		cached = build()
		for (const listener of listeners) listener()
	}

	function set(next: NotificationEntry[]): void {
		entries = next
		emit()
	}

	return {
		// Coalesce by `threadId` (freedesktop `replaces_id`): a re-post drops the prior
		// entry and appends fresh, so the pill shows one live item per thread, not a
		// stack. The agent rides a single `threadId: 'agent'`.
		notify(notification) {
			const kept = notification.threadId
				? entries.filter((e) => e.notification.threadId !== notification.threadId)
				: entries
			const next = [...kept, { notification, at: Date.now(), dismissed: false, seen: false }]
			set(next.length > MAX_ENTRIES ? next.slice(next.length - MAX_ENTRIES) : next)
		},
		// Recede from the pill; stays in the center and counts as unread until seen.
		dismiss(id) {
			if (!entries.some((e) => e.notification.id === id && !e.dismissed)) return
			set(entries.map((e) => (e.notification.id === id ? { ...e, dismissed: true } : e)))
		},
		// The center was opened — clear the badge without discarding anything.
		markSeen() {
			if (entries.every((e) => e.seen)) return
			set(entries.map((e) => (e.seen ? e : { ...e, seen: true })))
		},
		clear() {
			if (entries.length === 0) return
			set([])
		},
		subscribe(listener) {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
		snapshot() {
			return cached
		}
	}
}

// The single browser-side sink. App notifications (Slice 2) and agent/cron frames
// (over `/ws`) both converge here → one pill slot, one center, one badge.
export const notificationStore = createNotificationStore()
