/**
 * Sync Engine — owns all server-flush logic for offline persistence.
 *
 * Flow:
 *   editor change → setPendingEdit(IDB) → scheduleFlush() → [debounce 3s] → doFlush() → DELETE from IDB
 *
 * Key properties:
 *   - IDB is written immediately on every scheduleFlush call (crash safety)
 *   - Server flush is debounced at 3s
 *   - At most one write in-flight per document (buffered, not dropped)
 *   - Error taxonomy: 401 re-auth, 409 conflict, 413 too-large, 429/5xx/network retry
 */

import { deletePendingEdit, getAllPendingEdits, getPendingEdit, setPendingEdit, type PendingEdit } from './db'

// ---------------------------------------------------------------------------
// Token registration
// ---------------------------------------------------------------------------

type TokenGetter = () => Promise<string | null>
let tokenGetter: TokenGetter | null = null

export function registerTokenGetter(getter: TokenGetter): void {
	tokenGetter = getter
}

async function getAuthHeader(): Promise<string> {
	const token = await tokenGetter?.()
	return `Bearer ${token ?? ''}`
}

// ---------------------------------------------------------------------------
// Event emitter for UI notifications
// ---------------------------------------------------------------------------

export type SyncEvent =
	| { type: 'auth-required' }
	| { type: 'conflict'; memoryId: string }
	| { type: 'too-large'; memoryId: string }
	| { type: 'sync-error'; memoryId: string; message: string }

type SyncListener = (event: SyncEvent) => void
const listeners = new Set<SyncListener>()

export function onSyncEvent(listener: SyncListener): () => void {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

function emit(event: SyncEvent): void {
	for (const l of listeners) l(event)
}

// ---------------------------------------------------------------------------
// Per-document in-flight state
// ---------------------------------------------------------------------------

interface DocSyncState {
	inFlight: boolean
	bufferedEdit: PendingEdit | null
	retryCount: number
	retryTimer: ReturnType<typeof setTimeout> | null
}

const syncStates = new Map<string, DocSyncState>()

function getState(memoryId: string): DocSyncState {
	let state = syncStates.get(memoryId)
	if (!state) {
		state = { inFlight: false, bufferedEdit: null, retryCount: 0, retryTimer: null }
		syncStates.set(memoryId, state)
	}
	return state
}

const RETRY_DELAYS_MS = [5_000, 15_000, 60_000]

function scheduleRetry(memoryId: string): void {
	const state = getState(memoryId)
	if (state.retryTimer) return // already scheduled
	const delay = RETRY_DELAYS_MS[Math.min(state.retryCount, RETRY_DELAYS_MS.length - 1)]
	state.retryCount++
	state.retryTimer = setTimeout(() => {
		state.retryTimer = null
		flushNow(memoryId)
	}, delay)
}

// ---------------------------------------------------------------------------
// Debounce timers
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 3_000
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()

function resetDebounce(memoryId: string): void {
	const existing = debounceTimers.get(memoryId)
	if (existing) clearTimeout(existing)
	debounceTimers.set(
		memoryId,
		setTimeout(() => {
			debounceTimers.delete(memoryId)
			flushNow(memoryId)
		}, DEBOUNCE_MS),
	)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Called by editors on every change.
 * Writes `edit` to IDB immediately, then debounces a server flush.
 */
export function scheduleFlush(memoryId: string, edit: PendingEdit): void {
	// Fire-and-forget IDB write — crash safety
	setPendingEdit(edit)
	resetDebounce(memoryId)
}

/**
 * Cancel the debounce timer and flush immediately.
 * Used by visibilitychange and unmount handlers.
 */
export async function flushAndCancel(memoryId: string): Promise<void> {
	const timer = debounceTimers.get(memoryId)
	if (timer) {
		clearTimeout(timer)
		debounceTimers.delete(memoryId)
	}
	await flushNow(memoryId)
}

/**
 * Flush a single document to the server right now (bypasses debounce).
 */
export async function flushNow(memoryId: string): Promise<void> {
	const edit = await getPendingEdit(memoryId)
	if (!edit) return
	await doFlush(edit)
}

/**
 * Flush all pending IDB edits to the server.
 * Called at app startup and on the 'online' event.
 */
export async function drainPendingEdits(): Promise<void> {
	if (!navigator.onLine) return
	const all = await getAllPendingEdits()
	await Promise.allSettled(all.map((edit) => doFlush(edit)))
}

// ---------------------------------------------------------------------------
// Core flush logic
// ---------------------------------------------------------------------------

async function doFlush(edit: PendingEdit): Promise<void> {
	const { memoryId } = edit
	const state = getState(memoryId)

	if (state.inFlight) {
		// Buffer — only latest content matters
		state.bufferedEdit = edit
		return
	}

	state.inFlight = true

	try {
		// Resolve draft key: "draft:" has no server ID yet
		let resolvedEdit = edit
		if (memoryId === 'draft:') {
			const rekeyed = await resolveDraftKey(edit)
			if (!rekeyed) return // error handled inside resolveDraftKey
			resolvedEdit = rekeyed
		}

		const ok = await sendToServer(resolvedEdit)
		if (!ok) return

		// Success — clean up IDB and reset retry counter
		await deletePendingEdit(resolvedEdit.memoryId)
		state.retryCount = 0

	} finally {
		state.inFlight = false
	}

	// Send buffered edit if one accumulated during the in-flight request
	const buffered = state.bufferedEdit
	if (buffered) {
		state.bufferedEdit = null
		// Update savedAt to now since content may be newer
		const latest: PendingEdit = { ...buffered, savedAt: Date.now() }
		await setPendingEdit(latest)
		// Re-enter — inFlight is false now
		doFlush(latest)
	}
}

/**
 * For "draft:" entries with no server ID: call GET /api/v1/draft to obtain
 * the server ID, re-key the IDB entry, and return the updated PendingEdit.
 */
async function resolveDraftKey(edit: PendingEdit): Promise<PendingEdit | null> {
	try {
		const res = await fetch('/api/v1/draft', {
			headers: { Authorization: await getAuthHeader() },
		})
		if (!res.ok) {
			await handleFlushError('draft:', res.status)
			return null
		}
		const data = (await res.json()) as { id: string }
		const newKey = `draft:${data.id}`

		// Re-key IDB
		await deletePendingEdit('draft:')
		const rekeyed: PendingEdit = { ...edit, memoryId: newKey }
		await setPendingEdit(rekeyed)

		// Move sync state to new key
		const oldState = syncStates.get('draft:')
		if (oldState) {
			syncStates.set(newKey, oldState)
			syncStates.delete('draft:')
		}

		return rekeyed
	} catch {
		await handleFlushError('draft:', null)
		return null
	}
}

/**
 * POST the edit to /api/v1/update. Returns true on success.
 */
async function sendToServer(edit: PendingEdit): Promise<boolean> {
	const { memoryId, content, title, path } = edit

	// Extract the real server ID from the memoryId
	const serverId = memoryId.startsWith('draft:') ? memoryId.slice(6) : memoryId
	if (!serverId) {
		// No server ID — should not reach here after resolveDraftKey
		return false
	}

	const body: Record<string, unknown> = { id: serverId, content }
	if (title !== undefined) body.title = title
	if (path !== undefined) body.path = path

	try {
		const res = await fetch('/api/v1/update', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: await getAuthHeader(),
			},
			body: JSON.stringify(body),
		})

		if (!res.ok) {
			await handleFlushError(memoryId, res.status)
			return false
		}

		return true
	} catch {
		await handleFlushError(memoryId, null)
		return false
	}
}

async function handleFlushError(memoryId: string, status: number | null): Promise<void> {
	if (status === 401) {
		// Hold in IDB — user must re-auth before we retry
		emit({ type: 'auth-required' })
	} else if (status === 409) {
		// Conflict — server wins, delete local copy, notify UI
		await deletePendingEdit(memoryId)
		emit({ type: 'conflict', memoryId })
	} else if (status === 413) {
		// Payload too large — cannot retry, delete and surface
		await deletePendingEdit(memoryId)
		emit({ type: 'too-large', memoryId })
	} else {
		// 429, 5xx, or network failure — keep in IDB and retry with backoff
		const message = status ? `HTTP ${status}` : 'Network error'
		emit({ type: 'sync-error', memoryId, message })
		scheduleRetry(memoryId)
	}
}
