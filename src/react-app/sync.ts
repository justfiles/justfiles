import { defaultMarkdownParser, defaultMarkdownSerializer } from 'prosemirror-markdown'
import type { Node as ProseMirrorNode } from 'prosemirror-model'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import type { LinkInfo } from '../core/store'
import {
	appendPendingPatch,
	deletePendingPatches,
	getAllPendingPatches,
	getPendingPatches,
	type PendingPatch
} from './db'
import { createTanstackRemoteMemoryService, type RemoteMemoryService } from './remote'
import { useApiClient } from './useApiClient'

export interface SyncDocumentData<TContent = unknown> {
	content: TContent
	id?: string
	title?: string | null
	path?: string | null
	source?: string | null
	created_at?: string
	updated_at?: string
	active?: number
	links?: LinkInfo[]
	tags?: string[]
}

export interface SyncDocument<TContent = unknown> {
	documentId: string
	data: SyncDocumentData<TContent>
	source: 'local' | 'remote'
	localUpdatedAt: number | null
	remoteUpdatedAt: number | null
	revision?: string | null
}

export interface SyncPatch<TContent = unknown> {
	content?: TContent
	title?: string | null
	path?: string | null
}

export interface SyncPushResult {
	localUpdatedAt: number
	queuedRemoteSync: boolean
}

export interface SyncRuntimeStatus {
	isOnline: boolean
}

export interface CachedSyncService<TContent = unknown> {
	load(documentId: string): Promise<SyncDocument<TContent> | null>
	push(documentId: string, patch: SyncPatch<TContent>, flush?: boolean): Promise<SyncPushResult>
	getRuntimeStatus(): SyncRuntimeStatus
	subscribeRuntime(listener: (status: SyncRuntimeStatus) => void): () => void
	destroy(): void
}

export type ProseMirrorJsonDocument = ReturnType<ProseMirrorNode['toJSON']>

type LocalPatch<TContent> = {
	id: string
	documentId: string
	savedAt: number
	patch: SyncPatch<TContent>
}

type RemoteDocument<TContent> = {
	documentId: string
	data: SyncDocumentData<TContent>
	updatedAt: number
	revision?: string | null
}

interface DocSyncState {
	phase: 'idle' | 'debouncing' | 'flushing' | 'retry_wait' | 'offline'
	retryCount: number
	retryTimer: ReturnType<typeof setTimeout> | null
	debounceTimer: ReturnType<typeof setTimeout> | null
	lastLocalUpdateAt: number | null
	lastRemoteSyncAt: number | null
	lastErrorAt: number | null
	revision?: string | null
}

const DEFAULT_DEBOUNCE_MS = 3_000
const RETRY_DELAYS_MS = [5_000, 15_000, 60_000] as const

type DocEvent =
	| { type: 'SCHEDULE_FLUSH' }
	| { type: 'FLUSH_NOW' }
	| { type: 'DEBOUNCE_FIRED' }
	| { type: 'RETRY_FIRED' }
	| { type: 'ONLINE' }
	| { type: 'OFFLINE' }

function getDefaultState(): DocSyncState {
	return {
		phase: 'idle',
		retryCount: 0,
		retryTimer: null,
		debounceTimer: null,
		lastLocalUpdateAt: null,
		lastRemoteSyncAt: null,
		lastErrorAt: null,
		revision: null
	}
}

type SerialQueue = {
	run<T>(fn: () => Promise<T>): Promise<T>
}

function createSerialQueue(): SerialQueue {
	let chain: Promise<void> = Promise.resolve()
	return {
		run<T>(fn: () => Promise<T>): Promise<T> {
			const next = chain.then(fn, fn) as Promise<T>
			chain = next.then(() => {}, () => {})
			return next
		}
	}
}

type DocActor = {
	documentId: string
	state: DocSyncState
	dispatch(event: DocEvent): Promise<void>
	destroy(): void
}

function createDocActor(args: {
	documentId: string
	getIsOnline: () => boolean
	listPatches: () => Promise<Array<LocalPatch<ProseMirrorJsonDocument>>>
	pushRemote: (
		patch: SyncPatch<ProseMirrorJsonDocument>
	) => Promise<{ updatedAt: number; revision?: string | null }>
	deletePendingPatches: (ids: string[]) => Promise<void>
}): DocActor {
	const { documentId, getIsOnline, listPatches, pushRemote, deletePendingPatches } = args

	const queue = createSerialQueue()
	const state = getDefaultState()
	state.phase = getIsOnline() ? 'idle' : 'offline'

	function destroy(): void {
		if (state.debounceTimer) clearTimeout(state.debounceTimer)
		if (state.retryTimer) clearTimeout(state.retryTimer)
		state.debounceTimer = null
		state.retryTimer = null
	}

	function cancelDebounce(): void {
		if (state.debounceTimer) clearTimeout(state.debounceTimer)
		state.debounceTimer = null
	}

	function cancelRetry(): void {
		if (state.retryTimer) clearTimeout(state.retryTimer)
		state.retryTimer = null
	}

	async function dispatch(event: DocEvent): Promise<void> {
		return queue.run(async () => {
			await step(event)
		})
	}

	function setDebounce(): void {
		cancelDebounce()
		state.debounceTimer = setTimeout(() => {
			state.debounceTimer = null
			void dispatch({ type: 'DEBOUNCE_FIRED' })
		}, DEFAULT_DEBOUNCE_MS)
		state.phase = 'debouncing'
	}

	function setRetry(): void {
		if (state.retryTimer) return
		const delay = RETRY_DELAYS_MS[Math.min(state.retryCount, RETRY_DELAYS_MS.length - 1)]
		state.retryCount++
		state.phase = 'retry_wait'
		state.retryTimer = setTimeout(() => {
			state.retryTimer = null
			void dispatch({ type: 'RETRY_FIRED' })
		}, delay)
	}

	async function performFlush(): Promise<void> {
		if (!getIsOnline()) return

		// Enter flushing phase before any awaits so we don't allow concurrent flushes.
		cancelDebounce()
		cancelRetry()
		state.phase = 'flushing'

		const patches = await listPatches()
		if (patches.length === 0) {
			state.phase = 'idle'
			return
		}

		const coalescedPatch = mergePatch<ProseMirrorJsonDocument>(patches.map((patch) => patch.patch))
		if (!coalescedPatch) {
			state.phase = 'idle'
			return
		}

		try {
			const result = await pushRemote(coalescedPatch)
			state.revision = result.revision ?? null
			state.lastRemoteSyncAt = result.updatedAt
			state.retryCount = 0
			await deletePendingPatches(patches.map((patch) => patch.id))
		} catch {
			state.lastErrorAt = Date.now()
			setRetry()
			return
		} finally {
			// If setRetry() ran, phase is already retry_wait.
			if (state.phase === 'flushing') state.phase = 'idle'
		}

		const remaining = await listPatches()
		if (remaining.length > 0) setDebounce()
	}

	async function step(event: DocEvent): Promise<void> {
		switch (event.type) {
			case 'OFFLINE': {
				cancelDebounce()
				cancelRetry()
				state.phase = 'offline'
				return
			}
			case 'ONLINE': {
				if (state.phase === 'offline') state.phase = 'idle'
				return
			}
		}

		if (!getIsOnline()) {
			// Keep state consistent even if we missed OFFLINE.
			cancelDebounce()
			cancelRetry()
			state.phase = 'offline'
			return
		}

		switch (event.type) {
			case 'SCHEDULE_FLUSH': {
				if (state.phase === 'flushing') return
				if (state.phase === 'retry_wait') return
				setDebounce()
				return
			}
			case 'FLUSH_NOW': {
				if (state.phase === 'flushing') return
				if (state.phase === 'retry_wait') cancelRetry()
				await performFlush()
				return
			}
			case 'DEBOUNCE_FIRED': {
				if (state.phase !== 'debouncing') return
				await performFlush()
				return
			}
			case 'RETRY_FIRED': {
				if (state.phase !== 'retry_wait') return
				await performFlush()
				return
			}
		}
	}

	return {
		documentId,
		state,
		dispatch,
		destroy
	}
}

function markdownToJson(markdown: string): ProseMirrorJsonDocument {
	return defaultMarkdownParser.parse(markdown).toJSON() as ProseMirrorJsonDocument
}

function jsonToMarkdown(content: ProseMirrorJsonDocument): string {
	return defaultMarkdownSerializer.serialize(defaultMarkdownParser.schema.nodeFromJSON(content))
}

function serializePatchValue<TContent>(patch: SyncPatch<TContent>): string {
	return JSON.stringify(patch)
}

function parsePatchValue<TContent>(value: string): SyncPatch<TContent> | null {
	try {
		return JSON.parse(value) as SyncPatch<TContent>
	} catch {
		return null
	}
}

function patchKind(patch: SyncPatch<unknown>): PendingPatch['kind'][] {
	const kinds: PendingPatch['kind'][] = []
	if (patch.content !== undefined) kinds.push('content')
	if (patch.title !== undefined) kinds.push('title')
	if (patch.path !== undefined) kinds.push('path')
	return kinds
}

async function appendPatch<TContent>(
	documentId: string,
	savedAt: number,
	patch: SyncPatch<TContent>
): Promise<void> {
	const serialized = serializePatchValue(patch)
	await Promise.all(
		patchKind(patch).map((kind) =>
			appendPendingPatch({
				documentId,
				kind,
				value: serialized,
				savedAt
			})
		)
	)
}

async function listPatches<TContent>(documentId: string): Promise<LocalPatch<TContent>[]> {
	const patches = await getPendingPatches(documentId)
	return patches
		.map((patch) => {
			const parsed = parsePatchValue<TContent>(patch.value)
			if (!parsed) return null
			return {
				id: patch.id,
				documentId: patch.documentId,
				savedAt: patch.savedAt,
				patch: parsed
			}
		})
		.filter((patch): patch is LocalPatch<TContent> => patch !== null)
		.sort((a, b) => a.savedAt - b.savedAt)
}

function mergeDocumentData<TContent>(
	base: SyncDocumentData<TContent> | null,
	patches: Array<SyncPatch<TContent>>
): SyncDocumentData<TContent> | null {
	if (!base && patches.length === 0) return null
	let current: SyncDocumentData<TContent> | null = base ? { ...base } : null

	for (const patch of patches) {
		if (!current) {
			if (patch.content === undefined) continue
			current = { content: patch.content }
		}
		if (!current) continue
		if (patch.content !== undefined) current.content = patch.content
		if (patch.title !== undefined) current.title = patch.title
		if (patch.path !== undefined) current.path = patch.path
	}

	return current
}

function mergePatch<TContent>(patches: Array<SyncPatch<TContent>>): SyncPatch<TContent> | null {
	if (patches.length === 0) return null
	const merged: SyncPatch<TContent> = {}

	for (const patch of patches) {
		if (patch.content !== undefined) merged.content = patch.content
		if (patch.title !== undefined) merged.title = patch.title
		if (patch.path !== undefined) merged.path = patch.path
	}

	return patchKind(merged).length > 0 ? merged : null
}

function latestPatchAt<TContent>(patches: Array<LocalPatch<TContent>>): number | null {
	return patches.length > 0 ? patches[patches.length - 1].savedAt : null
}

async function getRemoteDocument(
	remote: RemoteMemoryService,
	documentId: string
): Promise<RemoteDocument<ProseMirrorJsonDocument> | null> {
	const data = await remote.pull(documentId)
	if (!data) return null
	return {
		documentId,
		data: {
			id: data.id,
			content: markdownToJson(data.raw_text),
			title: data.title,
			path: data.path,
			source: data.source,
			created_at: data.created_at,
			updated_at: data.updated_at,
			active: data.active,
			links: data.links,
			tags: data.tags
		},
		updatedAt: Date.parse(data.updated_at) || Date.now()
	}
}

async function pushRemoteDocument(
	remote: RemoteMemoryService,
	documentId: string,
	patch: SyncPatch<ProseMirrorJsonDocument>
): Promise<{ updatedAt: number; revision?: string | null }> {
	await remote.push({
		id: documentId,
		content: patch.content !== undefined ? jsonToMarkdown(patch.content) : undefined,
		title: patch.title ?? undefined,
		path: patch.path ?? undefined
	})
	return {
		updatedAt: Date.now(),
		revision: null
	}
}

let syncSingleton: CachedSyncService<ProseMirrorJsonDocument> | null = null

export function createSyncSystem(
	remote: RemoteMemoryService
): CachedSyncService<ProseMirrorJsonDocument> {
	const actors = new Map<string, DocActor>()
	const runtimeListeners = new Set<(status: SyncRuntimeStatus) => void>()
	let runtimeStatus: SyncRuntimeStatus = {
		isOnline: typeof navigator === 'undefined' ? true : navigator.onLine
	}

	function getActor(documentId: string): DocActor {
		let actor = actors.get(documentId)
		if (!actor) {
			actor = createDocActor({
				documentId,
				getIsOnline: () => runtimeStatus.isOnline,
				listPatches: () => listPatches<ProseMirrorJsonDocument>(documentId),
				pushRemote: (patch) => pushRemoteDocument(remote, documentId, patch),
				deletePendingPatches
			})
			actors.set(documentId, actor)
		}
		return actor
	}

	async function buildLocalSnapshot(documentId: string): Promise<{
		data: SyncDocumentData<ProseMirrorJsonDocument> | null
		updatedAt: number | null
		patches: Array<LocalPatch<ProseMirrorJsonDocument>>
	}> {
		const patches = await listPatches<ProseMirrorJsonDocument>(documentId)
		return {
			data: mergeDocumentData<ProseMirrorJsonDocument>(null, patches.map((patch) => patch.patch)),
			updatedAt: latestPatchAt(patches),
			patches
		}
	}

	async function drainPendingPatches(): Promise<void> {
		if (!runtimeStatus.isOnline) return
		const all = await getAllPendingPatches()
		const ids = new Set(all.map((patch) => patch.documentId))
		await Promise.allSettled(Array.from(ids).map((documentId) => getActor(documentId).dispatch({ type: 'FLUSH_NOW' })))
	}

	function emitRuntimeStatus(): void {
		for (const listener of runtimeListeners) listener(runtimeStatus)
	}

	if (typeof window !== 'undefined') {
		window.addEventListener('online', () => {
			runtimeStatus = { isOnline: true }
			emitRuntimeStatus()
			for (const actor of actors.values()) void actor.dispatch({ type: 'ONLINE' })
			void drainPendingPatches()
		})
		window.addEventListener('offline', () => {
			runtimeStatus = { isOnline: false }
			emitRuntimeStatus()
			for (const actor of actors.values()) void actor.dispatch({ type: 'OFFLINE' })
		})
	}

	return {
		async load(documentId) {
			const actor = getActor(documentId)
			const state = actor.state
			const local = await buildLocalSnapshot(documentId)

			if (!runtimeStatus.isOnline) {
				if (!local.data) return null
				state.lastLocalUpdateAt = local.updatedAt
				return {
					documentId,
					data: local.data,
					source: 'local',
					localUpdatedAt: local.updatedAt,
					remoteUpdatedAt: state.lastRemoteSyncAt,
					revision: state.revision ?? null
				}
			}

			try {
				const remoteDoc = await getRemoteDocument(remote, documentId)
				if (!remoteDoc && !local.data) return null
				if (!remoteDoc && local.data) {
					state.lastLocalUpdateAt = local.updatedAt
					return {
						documentId,
						data: local.data,
						source: 'local',
						localUpdatedAt: local.updatedAt,
						remoteUpdatedAt: null,
						revision: state.revision ?? null
					}
				}
				if (!remoteDoc) return null

				state.lastRemoteSyncAt = remoteDoc.updatedAt
				state.revision = remoteDoc.revision ?? null

				const merged = mergeDocumentData(remoteDoc.data, local.patches.map((patch) => patch.patch))
				const hasLocal = local.data !== null && local.updatedAt !== null

				if (hasLocal && merged) {
					state.lastLocalUpdateAt = local.updatedAt
					void actor.dispatch({ type: 'SCHEDULE_FLUSH' })
					return {
						documentId,
						data: merged,
						source: 'local',
						localUpdatedAt: local.updatedAt,
						remoteUpdatedAt: remoteDoc.updatedAt,
						revision: state.revision ?? null
					}
				}

				return {
					documentId,
					data: remoteDoc.data,
					source: 'remote',
					localUpdatedAt: null,
					remoteUpdatedAt: remoteDoc.updatedAt,
					revision: remoteDoc.revision ?? null
				}
			} catch {
				state.lastErrorAt = Date.now()
				if (!local.data) return null
				state.lastLocalUpdateAt = local.updatedAt
				return {
					documentId,
					data: local.data,
					source: 'local',
					localUpdatedAt: local.updatedAt,
					remoteUpdatedAt: state.lastRemoteSyncAt,
					revision: state.revision ?? null
				}
			}
		},

		async push(documentId, patch, flush = false) {
			const updatedAt = Date.now()
			const actor = getActor(documentId)
			const state = actor.state
			if (patchKind(patch).length > 0) {
				await appendPatch(documentId, updatedAt, patch)
				state.lastLocalUpdateAt = updatedAt
			}

			if (flush) {
				await actor.dispatch({ type: 'FLUSH_NOW' })
			} else {
				void actor.dispatch({ type: 'SCHEDULE_FLUSH' })
			}

			return {
				localUpdatedAt: updatedAt,
				queuedRemoteSync: true
			}
		},

		getRuntimeStatus() {
			return runtimeStatus
		},

		subscribeRuntime(listener) {
			runtimeListeners.add(listener)
			return () => runtimeListeners.delete(listener)
		},

		destroy() {
			for (const actor of actors.values()) actor.destroy()
			actors.clear()
		}
	}
}

export function useSync(): CachedSyncService<ProseMirrorJsonDocument> {
	const api = useApiClient()
	const queryClient = useQueryClient()

	if (!syncSingleton) {
		syncSingleton = createSyncSystem(createTanstackRemoteMemoryService(queryClient, api))
	}

	return syncSingleton
}

export function useSyncRuntimeStatus(): SyncRuntimeStatus {
	const sync = useSync()
	const [status, setStatus] = useState(() => sync.getRuntimeStatus())

	useEffect(() => sync.subscribeRuntime(setStatus), [])

	return status
}
