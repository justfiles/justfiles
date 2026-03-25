import { markdownToDoc, docToMarkdown, schema as remarkSchema } from '../prosemirror-remark'
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
import { createMachineRuntime } from './sync.runtime'
import {
	createInitialDocState,
	transition,
	type DocEffect,
	type DocEvent,
	type DocState
} from './sync.state'
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

type DocActor = {
	documentId: string
	readonly state: DocState
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

	let debounceTimer: ReturnType<typeof setTimeout> | null = null
	let retryTimer: ReturnType<typeof setTimeout> | null = null

	function destroy(): void {
		cancelDebounce()
		cancelRetry()
	}

	function cancelDebounce(): void {
		if (debounceTimer) clearTimeout(debounceTimer)
		debounceTimer = null
	}

	function cancelRetry(): void {
		if (retryTimer) clearTimeout(retryTimer)
		retryTimer = null
	}

	function requiresOnline(event: DocEvent): boolean {
		return (
			event.type === 'SCHEDULE_FLUSH' ||
			event.type === 'FLUSH_NOW' ||
			event.type === 'DEBOUNCE_FIRED' ||
			event.type === 'RETRY_FIRED'
		)
	}

	async function performFlush(
		dispatchTransition: (event: DocEvent) => Promise<void>
	): Promise<void> {
		try {
			const patches = await listPatches()
			if (patches.length === 0) {
				await dispatchTransition({ type: 'FLUSH_SKIPPED', hasRemaining: false })
				return
			}

			const coalescedPatch = mergePatch<ProseMirrorJsonDocument>(
				patches.map((patch) => patch.patch)
			)
			if (!coalescedPatch) {
				await dispatchTransition({ type: 'FLUSH_SKIPPED', hasRemaining: false })
				return
			}

			const result = await pushRemote(coalescedPatch)
			await deletePendingPatches(patches.map((patch) => patch.id))
			const remaining = await listPatches()
			await dispatchTransition({
				type: 'FLUSH_SUCCEEDED',
				updatedAt: result.updatedAt,
				revision: result.revision ?? null,
				hasRemaining: remaining.length > 0
			})
		} catch (err) {
			console.error('[sync] performFlush failed:', err)
			await dispatchTransition({ type: 'FLUSH_FAILED', at: Date.now() })
		}
	}

	const runtime = createMachineRuntime<DocState, DocEvent, DocEffect>({
		initialState: createInitialDocState(getIsOnline()),
		transition,
		onDestroy: destroy,
		runEffect: async (effect, context) => {
			switch (effect.type) {
				case 'CANCEL_DEBOUNCE':
					cancelDebounce()
					break
				case 'CANCEL_RETRY':
					cancelRetry()
					break
				case 'START_DEBOUNCE':
					cancelDebounce()
					debounceTimer = setTimeout(() => {
						debounceTimer = null
						void runtime.dispatch({ type: 'DEBOUNCE_FIRED' })
					}, effect.delayMs)
					break
				case 'START_RETRY':
					cancelRetry()
					retryTimer = setTimeout(() => {
						retryTimer = null
						void runtime.dispatch({ type: 'RETRY_FIRED' })
					}, effect.delayMs)
					break
				case 'RUN_FLUSH':
					await performFlush(context.transition)
					break
			}
		}
	})

	async function dispatch(event: DocEvent): Promise<void> {
		if (requiresOnline(event) && !getIsOnline()) {
			return runtime.dispatch({ type: 'OFFLINE' })
		}
		return runtime.dispatch(event)
	}

	return {
		documentId,
		get state() {
			return runtime.state
		},
		dispatch,
		destroy: () => runtime.destroy()
	}
}

function markdownToJson(markdown: string): ProseMirrorJsonDocument {
	return markdownToDoc(markdown, remarkSchema).toJSON() as ProseMirrorJsonDocument
}

function jsonToMarkdown(content: ProseMirrorJsonDocument): string {
	return docToMarkdown(remarkSchema.nodeFromJSON(content))
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
			data: mergeDocumentData<ProseMirrorJsonDocument>(
				null,
				patches.map((patch) => patch.patch)
			),
			updatedAt: latestPatchAt(patches),
			patches
		}
	}

	async function drainPendingPatches(): Promise<void> {
		if (!runtimeStatus.isOnline) return
		const all = await getAllPendingPatches()
		const ids = new Set(all.map((patch) => patch.documentId))
		await Promise.allSettled(
			Array.from(ids).map((documentId) => getActor(documentId).dispatch({ type: 'FLUSH_NOW' }))
		)
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
		// Drain any patches left over from a previous session on startup
		void drainPendingPatches()
	}

	return {
		async load(documentId) {
			const actor = getActor(documentId)
			const local = await buildLocalSnapshot(documentId)

			if (!runtimeStatus.isOnline) {
				if (!local.data) return null
				if (local.updatedAt !== null) {
					await actor.dispatch({ type: 'LOCAL_UPDATED', at: local.updatedAt })
				}
				const state = actor.state
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
					if (local.updatedAt !== null) {
						await actor.dispatch({ type: 'LOCAL_UPDATED', at: local.updatedAt })
					}
					const state = actor.state
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

				await actor.dispatch({
					type: 'REMOTE_LOADED',
					at: remoteDoc.updatedAt,
					revision: remoteDoc.revision ?? null
				})

				const merged = mergeDocumentData(
					remoteDoc.data,
					local.patches.map((patch) => patch.patch)
				)
				const localUpdatedAt = local.updatedAt
				const hasLocal = local.data !== null && localUpdatedAt !== null

				if (hasLocal && merged) {
					await actor.dispatch({ type: 'LOCAL_UPDATED', at: localUpdatedAt })
					void actor.dispatch({ type: 'SCHEDULE_FLUSH' })
					const state = actor.state
					return {
						documentId,
						data: merged,
						source: 'local',
						localUpdatedAt,
						remoteUpdatedAt: remoteDoc.updatedAt,
						revision: state.revision ?? null
					}
				}

				const state = actor.state
				return {
					documentId,
					data: remoteDoc.data,
					source: 'remote',
					localUpdatedAt: null,
					remoteUpdatedAt: state.lastRemoteSyncAt,
					revision: state.revision ?? null
				}
			} catch {
				await actor.dispatch({ type: 'LOAD_ERROR', at: Date.now() })
				if (!local.data) return null
				if (local.updatedAt !== null) {
					await actor.dispatch({ type: 'LOCAL_UPDATED', at: local.updatedAt })
				}
				const state = actor.state
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
			if (patchKind(patch).length > 0) {
				await appendPatch(documentId, updatedAt, patch)
				await actor.dispatch({ type: 'LOCAL_UPDATED', at: updatedAt })
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
