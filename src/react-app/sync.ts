import { defaultMarkdownParser, defaultMarkdownSerializer } from 'prosemirror-markdown'
import type { Node as ProseMirrorNode } from 'prosemirror-model'
import type { UpdateInput } from '../core/store'
import { useEffect, useState } from 'react'
import {
	appendPendingPatch,
	deletePendingPatches,
	getAllPendingPatches,
	getPendingPatches,
	type PendingPatch
} from './db'
import { useApiClient, type ApiClient } from './useApiClient'

export interface SyncDocumentData<TContent = unknown> {
	content: TContent
	title?: string | null
	path?: string | null
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

type ApiClientResolver = () => Promise<ApiClient>

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

const DRAFT_DOCUMENT_ID = 'draft'
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

function isDraftDocumentId(documentId: string): boolean {
	return documentId === DRAFT_DOCUMENT_ID
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

async function getDraftRemoteDocument(
	getApiClient: ApiClientResolver
): Promise<RemoteDocument<ProseMirrorJsonDocument>> {
	const res = await (await getApiClient()).v1.draft.$get()
	if (!res.ok) throw new Error(`Failed to load draft: ${res.status}`)
	const data = (await res.json()) as {
		id: string
		raw_text: string
		updated_at?: string
	}
	return {
		documentId: DRAFT_DOCUMENT_ID,
		data: {
			content: markdownToJson(data.raw_text),
			path: '*draft*',
			title: null
		},
		updatedAt: data.updated_at ? Date.parse(data.updated_at) || Date.now() : Date.now()
	}
}

async function getRemoteDocument(
	getApiClient: ApiClientResolver,
	documentId: string
): Promise<RemoteDocument<ProseMirrorJsonDocument> | null> {
	if (isDraftDocumentId(documentId)) return getDraftRemoteDocument(getApiClient)
	const res = await (await getApiClient()).v1.memory[':id'].$get({ param: { id: documentId } })
	if (res.status === 404) return null
	if (!res.ok) throw new Error(`Failed to load memory: ${res.status}`)
	const data = (await res.json()) as {
		raw_text: string
		title: string | null
		path: string
		updated_at: string
	}
	return {
		documentId,
		data: {
			content: markdownToJson(data.raw_text),
			title: data.title,
			path: data.path
		},
		updatedAt: Date.parse(data.updated_at) || Date.now()
	}
}

async function resolveDraftTargetId(getApiClient: ApiClientResolver): Promise<string> {
	const res = await (await getApiClient()).v1.draft.$get()
	if (!res.ok) throw new Error(`Failed to resolve draft: ${res.status}`)
	const data = (await res.json()) as { id: string }
	return data.id
}

async function pushRemoteDocument(
	getApiClient: ApiClientResolver,
	documentId: string,
	patch: SyncPatch<ProseMirrorJsonDocument>
): Promise<{ updatedAt: number; revision?: string | null }> {
	const targetId = isDraftDocumentId(documentId)
		? await resolveDraftTargetId(getApiClient)
		: documentId
	const json: UpdateInput = { id: targetId }
	if (patch.content !== undefined) json.content = jsonToMarkdown(patch.content)
	if (patch.title !== undefined) json.title = patch.title ?? undefined
	if (patch.path !== undefined) json.path = patch.path ?? undefined
	const res = await (await getApiClient()).v1.update.$post({ json })
	if (!res.ok) throw new Error(`Failed to sync memory: ${res.status}`)
	return {
		updatedAt: Date.now(),
		revision: null
	}
}

let syncSingleton: CachedSyncService<ProseMirrorJsonDocument> | null = null

export function createSyncSystem(
	getApiClient: () => Promise<ApiClient>
): CachedSyncService<ProseMirrorJsonDocument> {
	const states = new Map<string, DocSyncState>()
	const runtimeListeners = new Set<(status: SyncRuntimeStatus) => void>()
	let runtimeStatus: SyncRuntimeStatus = {
		isOnline: typeof navigator === 'undefined' ? true : navigator.onLine
	}
	let apiClientPromise: Promise<ApiClient> | null = null

	function resolveApiClient(): Promise<ApiClient> {
		if (!apiClientPromise) apiClientPromise = getApiClient()
		return apiClientPromise
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
			const result = await pushRemoteDocument(resolveApiClient, documentId, coalescedPatch)
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
				const remote = await getRemoteDocument(resolveApiClient, documentId)
				if (!remote && !local.data) return null
				if (!remote && local.data) {
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
				if (!remote) return null

				state.lastRemoteSyncAt = remote.updatedAt
				state.revision = remote.revision ?? null

				const merged = mergeDocumentData(remote.data, local.patches.map((patch) => patch.patch))
				const hasLocal = local.data !== null && local.updatedAt !== null

				if (hasLocal && merged) {
					state.lastLocalUpdateAt = local.updatedAt
					scheduleFlush(documentId)
					return {
						documentId,
						data: merged,
						source: 'local',
						localUpdatedAt: local.updatedAt,
						remoteUpdatedAt: remote.updatedAt,
						revision: state.revision ?? null
					}
				}

				return {
					documentId,
					data: remote.data,
					source: 'remote',
					localUpdatedAt: null,
					remoteUpdatedAt: remote.updatedAt,
					revision: remote.revision ?? null
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

	if (!syncSingleton) {
		syncSingleton = createSyncSystem(async () => api)
	}

	return syncSingleton
}

export function useSyncRuntimeStatus(): SyncRuntimeStatus {
	const sync = useSync()
	const [status, setStatus] = useState(() => sync.getRuntimeStatus())

	useEffect(() => sync.subscribeRuntime(setStatus), [])

	return status
}
