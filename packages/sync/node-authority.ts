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
			mutations: operation.mutations
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
			nextMutations.push({ ...mutation, revision } as NodeMutation)
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
