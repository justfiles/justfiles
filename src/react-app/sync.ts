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
	inFlight: boolean
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

function getDefaultState(): DocSyncState {
	return {
		inFlight: false,
		retryCount: 0,
		retryTimer: null,
		debounceTimer: null,
		lastLocalUpdateAt: null,
		lastRemoteSyncAt: null,
		lastErrorAt: null,
		revision: null
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
	const states = new Map<string, DocSyncState>()
	const runtimeListeners = new Set<(status: SyncRuntimeStatus) => void>()
	let runtimeStatus: SyncRuntimeStatus = {
		isOnline: typeof navigator === 'undefined' ? true : navigator.onLine
	}

	function getState(documentId: string): DocSyncState {
		let state = states.get(documentId)
		if (!state) {
			state = getDefaultState()
			states.set(documentId, state)
		}
		return state
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

	async function flushDocument(documentId: string): Promise<void> {
		if (!navigator.onLine) return
		const state = getState(documentId)
		if (state.inFlight) return

		const patches = await listPatches<ProseMirrorJsonDocument>(documentId)
		if (patches.length === 0) return

		const coalescedPatch = mergePatch<ProseMirrorJsonDocument>(patches.map((patch) => patch.patch))
		if (!coalescedPatch) return

		state.inFlight = true

		try {
			const result = await pushRemoteDocument(remote, documentId, coalescedPatch)
			state.revision = result.revision ?? null
			state.lastRemoteSyncAt = result.updatedAt
			state.retryCount = 0
			await deletePendingPatches(patches.map((patch) => patch.id))
		} catch {
			state.lastErrorAt = Date.now()
			scheduleRetry(documentId)
			return
		} finally {
			state.inFlight = false
		}

		const remaining = await listPatches<ProseMirrorJsonDocument>(documentId)
		if (remaining.length > 0) scheduleFlush(documentId)
	}

	function scheduleRetry(documentId: string): void {
		const state = getState(documentId)
		if (state.retryTimer) return
		const delay = RETRY_DELAYS_MS[Math.min(state.retryCount, RETRY_DELAYS_MS.length - 1)]
		state.retryCount++
		state.retryTimer = setTimeout(() => {
			state.retryTimer = null
			void flushDocument(documentId)
		}, delay)
	}

	function scheduleFlush(documentId: string): void {
		const state = getState(documentId)
		if (state.debounceTimer) clearTimeout(state.debounceTimer)
		state.debounceTimer = setTimeout(() => {
			state.debounceTimer = null
			void flushDocument(documentId)
		}, DEFAULT_DEBOUNCE_MS)
	}

	async function drainPendingPatches(): Promise<void> {
		if (!navigator.onLine) return
		const all = await getAllPendingPatches()
		const ids = new Set(all.map((patch) => patch.documentId))
		await Promise.allSettled(Array.from(ids).map((documentId) => flushDocument(documentId)))
	}

	function emitRuntimeStatus(): void {
		for (const listener of runtimeListeners) listener(runtimeStatus)
	}

	if (typeof window !== 'undefined') {
		window.addEventListener('online', () => {
			runtimeStatus = { isOnline: true }
			emitRuntimeStatus()
			void drainPendingPatches()
		})
		window.addEventListener('offline', () => {
			runtimeStatus = { isOnline: false }
			emitRuntimeStatus()
		})
	}

	return {
		async load(documentId) {
			const state = getState(documentId)
			const local = await buildLocalSnapshot(documentId)

			if (!navigator.onLine) {
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
					scheduleFlush(documentId)
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
			const state = getState(documentId)
			if (patchKind(patch).length > 0) {
				await appendPatch(documentId, updatedAt, patch)
				state.lastLocalUpdateAt = updatedAt
			}

			if (flush) {
				const timer = state.debounceTimer
				if (timer) {
					clearTimeout(timer)
					state.debounceTimer = null
				}
				await flushDocument(documentId)
			} else {
				scheduleFlush(documentId)
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
			for (const state of states.values()) {
				if (state.debounceTimer) clearTimeout(state.debounceTimer)
				if (state.retryTimer) clearTimeout(state.retryTimer)
			}
			states.clear()
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
