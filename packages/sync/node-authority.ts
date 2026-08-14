import type { TreePort } from '@justfiles/fs/storage.shared'
import { FileType } from '@justfiles/fs/types'
import type {
	NodeMutation,
	NodeOperation,
	NodeOperationResult,
	NodeState,
	NodeStore,
	SyncNodeId
} from './node'

type Options = {
	source?: string
	origin?: string
	content?: ReadonlyMap<string, Uint8Array>
}

function shared(state: NodeState): Omit<NodeState, 'localIno'> {
	const { localIno: _localIno, ...rest } = state
	return rest
}

function validName(name: string): boolean {
	return (
		name.length > 0 &&
		!name.includes('/') &&
		name !== '.' &&
		name !== '..' &&
		name.normalize('NFC') === name
	)
}

function accepted(
	operationId: string,
	mutations: readonly NodeMutation[],
	origin?: string
): Extract<NodeOperationResult, { status: 'accepted' }> {
	return {
		status: 'accepted',
		operation: {
			operationId,
			mutations: [...mutations],
			...(origin ? { origin } : {})
		}
	}
}

/** Check the whole boundary manifest before one adapter transaction applies it. */
async function acceptBoundary(
	nodes: NodeStore,
	operation: NodeOperation,
	request: string,
	rootId: SyncNodeId,
	apply: (mutation: NodeMutation) => Promise<boolean>,
	opts?: Options
): Promise<NodeOperationResult> {
	let phase: 'delete' | 'move' | 'create' = 'delete'
	let moves = 0
	for (const mutation of operation.mutations) {
		if (mutation.kind === 'update' || ('projection' in mutation && mutation.projection))
			return { status: 'rejected', reason: 'invalid', operationId: operation.operationId }
		if (mutation.kind === 'delete') {
			if (phase !== 'delete')
				return { status: 'rejected', reason: 'invalid', operationId: operation.operationId }
			continue
		}
		if (mutation.kind === 'move') {
			if (phase === 'create' || moves++ > 0)
				return { status: 'rejected', reason: 'invalid', operationId: operation.operationId }
			phase = 'move'
			continue
		}
		phase = 'create'
	}

	const states = new Map((await nodes.live()).map((state) => [state.id, state]))
	for (const mutation of operation.mutations) {
		if (states.has(mutation.nodeId)) continue
		const state = await nodes.get(mutation.nodeId)
		if (state) states.set(state.id, state)
	}
	const mutations: NodeMutation[] = []
	for (const mutation of operation.mutations) {
		if (mutation.nodeId === rootId && mutation.kind !== 'create')
			return { status: 'rejected', reason: 'invalid', operationId: operation.operationId }
		const current = states.get(mutation.nodeId)
		if (current?.deleted)
			return {
				status: 'rejected',
				reason: 'deleted',
				operationId: operation.operationId,
				current: shared(current)
			}
		if (mutation.kind === 'create' && current)
			return { status: 'rejected', reason: 'invalid', operationId: operation.operationId }
		if (mutation.kind !== 'create' && !current)
			return { status: 'rejected', reason: 'not_found', operationId: operation.operationId }
		if (current && mutation.kind !== 'create' && mutation.baseRevision !== current.revision)
			return {
				status: 'rejected',
				reason: 'stale',
				operationId: operation.operationId,
				current: shared(current)
			}

		if (mutation.kind === 'create' || mutation.kind === 'move') {
			if (!validName(mutation.name))
				return {
					status: 'rejected',
					reason: 'invalid_name',
					operationId: operation.operationId
				}
			const parent = states.get(mutation.parentId)
			const issue = !parent
				? 'missing'
				: parent.deleted
					? 'deleted'
					: parent.type !== FileType.Directory
						? 'not_directory'
						: undefined
			if (issue)
				return {
					status: 'rejected',
					reason: 'invalid_parent',
					operationId: operation.operationId,
					issue
				}
			const occupant = [...states.values()].find(
				(state) =>
					!state.deleted &&
					state.parentId === mutation.parentId &&
					state.name === mutation.name &&
					state.id !== mutation.nodeId
			)
			if (occupant)
				return {
					status: 'rejected',
					reason: 'collision',
					operationId: operation.operationId,
					occupant: shared(occupant)
				}
		}

		if (mutation.kind === 'create') {
			if ((mutation.meta.type === FileType.Regular) !== (mutation.contentHash !== undefined))
				return {
					status: 'rejected',
					reason: 'invalid_content',
					operationId: operation.operationId
				}
			const next: NodeState = {
				id: mutation.nodeId,
				localIno: null,
				parentId: mutation.parentId,
				name: mutation.name,
				type: mutation.meta.type,
				revision: 1,
				deleted: false,
				materialization: 'absent',
				meta: mutation.meta,
				contentHash: mutation.contentHash
			}
			states.set(next.id, next)
			mutations.push({ ...mutation, revision: 1 })
			continue
		}

		if (!current)
			return { status: 'rejected', reason: 'not_found', operationId: operation.operationId }
		const revision = current.revision + 1
		if (mutation.kind === 'delete') {
			if (
				current.type === FileType.Directory &&
				[...states.values()].some((state) => !state.deleted && state.parentId === current.id)
			)
				return {
					status: 'rejected',
					reason: 'not_empty',
					operationId: operation.operationId
				}
			states.set(current.id, {
				...current,
				localIno: null,
				revision,
				deleted: true,
				materialization: 'absent'
			})
			mutations.push({ ...mutation, revision })
			continue
		}
		if (mutation.kind !== 'move')
			return { status: 'rejected', reason: 'invalid', operationId: operation.operationId }

		if (current.type === FileType.Directory) {
			const seen = new Set<SyncNodeId>()
			let parentId: SyncNodeId | null = mutation.parentId
			while (parentId !== null && !seen.has(parentId)) {
				if (parentId === mutation.nodeId)
					return { status: 'rejected', reason: 'cycle', operationId: operation.operationId }
				seen.add(parentId)
				parentId = states.get(parentId)?.parentId ?? null
			}
		}
		states.set(current.id, {
			...current,
			parentId: mutation.parentId,
			name: mutation.name,
			revision
		})
		mutations.push({
			...mutation,
			fromParentId: current.parentId ?? undefined,
			fromName: current.name,
			revision
		})
	}

	for (const mutation of mutations)
		if (!(await apply(mutation))) throw new Error('validated node mutation was not applied')
	const result = accepted(operation.operationId, mutations, opts?.origin)
	await nodes.append(result.operation, opts?.source)
	await nodes.saveOperation(operation.operationId, request, result)
	return result
}

/** Apply authored node operations under one adapter-owned transaction. */
export async function acceptNodeOperations(
	port: TreePort,
	nodes: NodeStore,
	operations: readonly NodeOperation[],
	rootId: SyncNodeId,
	apply: (mutation: NodeMutation) => Promise<boolean>,
	opts?: Options
): Promise<NodeOperationResult[]> {
	const results: NodeOperationResult[] = []
	operationLoop: for (const operation of operations) {
		const request = JSON.stringify({
			operationId: operation.operationId,
			mutations: operation.mutations,
			boundary: operation.boundary
		})
		const prior = await nodes.getOperation(operation.operationId)
		if (prior) {
			results.push(
				prior.request === request
					? prior.result
					: { status: 'rejected', reason: 'invalid', operationId: operation.operationId }
			)
			continue
		}
		if (operation.boundary) {
			results.push(await acceptBoundary(nodes, operation, request, rootId, apply, opts))
			continue
		}

		const [first, second] = operation.mutations
		const replacement =
			operation.mutations.length === 2 && first?.kind === 'delete' && second?.kind === 'move'
				? { remove: first, move: second }
				: undefined
		if (
			!first ||
			(operation.mutations.length !== 1 && !replacement) ||
			(replacement && replacement.remove.nodeId === replacement.move.nodeId)
		) {
			results.push({ status: 'rejected', reason: 'invalid', operationId: operation.operationId })
			continue
		}

		const nextMutations: NodeMutation[] = []
		for (const mutation of operation.mutations) {
			if ('projection' in mutation && mutation.projection) {
				results.push({ status: 'rejected', reason: 'invalid', operationId: operation.operationId })
				continue operationLoop
			}
			if (mutation.nodeId === rootId && (mutation.kind === 'move' || mutation.kind === 'delete')) {
				results.push({ status: 'rejected', reason: 'invalid', operationId: operation.operationId })
				continue operationLoop
			}

			const location =
				mutation.kind === 'create' || mutation.kind === 'move'
					? { parentId: mutation.parentId, name: mutation.name }
					: undefined
			if (location && !validName(location.name)) {
				results.push({
					status: 'rejected',
					reason: 'invalid_name',
					operationId: operation.operationId
				})
				continue operationLoop
			}

			const current = await nodes.get(mutation.nodeId)
			if (current?.deleted) {
				results.push({
					status: 'rejected',
					reason: 'deleted',
					operationId: operation.operationId,
					current: shared(current)
				})
				continue operationLoop
			}
			if (mutation.kind === 'create' && current) {
				results.push({ status: 'rejected', reason: 'invalid', operationId: operation.operationId })
				continue operationLoop
			}
			if (mutation.kind !== 'create' && !current) {
				results.push({
					status: 'rejected',
					reason: 'not_found',
					operationId: operation.operationId
				})
				continue operationLoop
			}

			if (mutation.kind === 'create' || mutation.kind === 'update') {
				if (mutation.kind === 'update' && current && mutation.meta.type !== current.type) {
					results.push({
						status: 'rejected',
						reason: 'invalid',
						operationId: operation.operationId
					})
					continue operationLoop
				}
				const type = mutation.kind === 'create' ? mutation.meta.type : current?.type
				if (
					(type === FileType.Regular && mutation.contentHash === undefined) ||
					(type !== FileType.Regular && mutation.contentHash !== undefined)
				) {
					results.push({
						status: 'rejected',
						reason: 'invalid_content',
						operationId: operation.operationId
					})
					continue operationLoop
				}
			}
			if (current && mutation.kind !== 'create' && mutation.baseRevision !== current.revision) {
				results.push({
					status: 'rejected',
					reason: 'stale',
					operationId: operation.operationId,
					current: shared(current)
				})
				continue operationLoop
			}

			if (location) {
				const parent = await nodes.get(location.parentId)
				const issue = !parent
					? 'missing'
					: parent.deleted
						? 'deleted'
						: parent.type !== FileType.Directory
							? 'not_directory'
							: undefined
				if (issue) {
					results.push({
						status: 'rejected',
						reason: 'invalid_parent',
						operationId: operation.operationId,
						issue
					})
					continue operationLoop
				}

				const occupant = await nodes.at(location.parentId, location.name)
				if (replacement?.move === mutation) {
					if (!occupant) {
						results.push({
							status: 'rejected',
							reason: 'invalid',
							operationId: operation.operationId
						})
						continue operationLoop
					}
					if (occupant.id !== replacement.remove.nodeId) {
						results.push({
							status: 'rejected',
							reason: 'collision',
							operationId: operation.operationId,
							occupant: shared(occupant)
						})
						continue operationLoop
					}
				} else if (occupant && occupant.id !== mutation.nodeId) {
					results.push({
						status: 'rejected',
						reason: 'collision',
						operationId: operation.operationId,
						occupant: shared(occupant)
					})
					continue operationLoop
				}
			}

			if (
				mutation.kind === 'move' &&
				current &&
				current.parentId === mutation.parentId &&
				current.name === mutation.name
			) {
				const result = accepted(
					operation.operationId,
					[{ ...mutation, revision: current.revision }],
					opts?.origin
				)
				await nodes.saveOperation(operation.operationId, request, result)
				results.push(result)
				continue operationLoop
			}

			if (
				mutation.kind === 'delete' &&
				current?.type === FileType.Directory &&
				current.localIno !== null &&
				(await port.dirHasLiveChildren(current.localIno))
			) {
				results.push({
					status: 'rejected',
					reason: 'not_empty',
					operationId: operation.operationId
				})
				continue operationLoop
			}

			if (mutation.kind === 'move' && current?.type === FileType.Directory) {
				const seen = new Set<SyncNodeId>()
				let parentId: SyncNodeId | null = mutation.parentId
				while (parentId !== null && !seen.has(parentId)) {
					if (parentId === mutation.nodeId) break
					seen.add(parentId)
					parentId = (await nodes.get(parentId))?.parentId ?? null
				}
				if (parentId === mutation.nodeId) {
					results.push({
						status: 'rejected',
						reason: 'cycle',
						operationId: operation.operationId
					})
					continue operationLoop
				}
			}

			const revision =
				mutation.kind === 'create' ? 1 : (current?.revision ?? mutation.baseRevision) + 1
			nextMutations.push(
				mutation.kind === 'move' && current && current.parentId !== null
					? {
							...mutation,
							fromParentId: current.parentId,
							fromName: current.name,
							revision
						}
					: ({ ...mutation, revision } as NodeMutation)
			)
		}

		for (const mutation of nextMutations)
			if (!(await apply(mutation))) throw new Error('validated node mutation was not applied')
		const result = accepted(operation.operationId, nextMutations, opts?.origin)
		await nodes.append(result.operation, opts?.source)
		await nodes.saveOperation(operation.operationId, request, result)
		results.push(result)
	}
	return results
}
