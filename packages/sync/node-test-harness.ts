import { volume } from '@justfiles/fs'
import type { Storage } from '@justfiles/fs/storage'
import {
	mutationsOf,
	type NodeReplica,
	nodeAuthorityReplica,
	ROOT_NODE_ID,
	type SyncCapability
} from './node'
import { storageSyncReplica } from './strategy'

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)
const text = (value: Uint8Array): string => new TextDecoder().decode(value)

function replica(storage: Storage): NodeReplica {
	const selected = storageSyncReplica(storage)
	if (selected.strategy !== 'incremental') throw new Error('expected incremental sync')
	return selected.replica
}

function authority(storage: Storage): NodeReplica {
	const sync = (storage.caps as { sync?: SyncCapability } | undefined)?.sync
	if (!sync) throw new Error('expected sync capability')
	return nodeAuthorityReplica(sync, storage.caps?.content)
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message)
}

export type NodeBackendFactory = () => Storage

export type NodeConformanceCase = {
	name: string
	run(makeBackend: NodeBackendFactory): Promise<void>
}

export const nodeSyncConformanceCases: NodeConformanceCase[] = [
	{
		name: 'create, update, move, delete, path reuse, and retry converge',
		async run(makeBackend) {
			const sourceStorage = makeBackend()
			const targetStorage = makeBackend()
			const source = replica(sourceStorage)
			const target = replica(targetStorage)
			const sourceVolume = volume(sourceStorage)
			const targetVolume = volume(targetStorage)
			await sourceVolume.mkdir('/old')
			await sourceVolume.mkdir('/new')
			await sourceVolume.writeFile('/old/note.txt', bytes('one'))
			let delta = await source.nodeDeltas('', { limit: 100 })
			const oldId = mutationsOf(delta.operations).find(
				(mutation) => mutation.kind === 'create' && mutation.name === 'note.txt'
			)?.nodeId
			assert(oldId, 'create did not publish a node ID')
			await target.applyNodeOperations(delta.operations, (hash) => source.getBlobByHash(hash))
			let cursor = delta.to

			await sourceVolume.writeFile('/old/note.txt', bytes('two'))
			await sourceVolume.rename('/old/note.txt', '/new/note.txt')
			delta = await source.nodeDeltas(cursor, { limit: 100 })
			await target.applyNodeOperations(delta.operations, (hash) => source.getBlobByHash(hash))
			await target.applyNodeOperations(delta.operations, () =>
				Promise.reject(new Error('retry requested content'))
			)
			assert(text(await targetVolume.readFile('/new/note.txt')) === 'two', 'update did not apply')
			assert(!(await targetVolume.exists('/old/note.txt')), 'move kept the old path')
			cursor = delta.to

			await sourceVolume.rm('/new/note.txt')
			delta = await source.nodeDeltas(cursor, { limit: 100 })
			await target.applyNodeOperations(delta.operations, (hash) => source.getBlobByHash(hash))
			assert(!(await targetVolume.exists('/new/note.txt')), 'delete did not apply')
			cursor = delta.to

			await sourceVolume.writeFile('/new/note.txt', bytes('new identity'))
			delta = await source.nodeDeltas(cursor, { limit: 100 })
			const newId = mutationsOf(delta.operations).find(
				(mutation) => mutation.kind === 'create' && mutation.name === 'note.txt'
			)?.nodeId
			assert(newId && newId !== oldId, 'path reuse kept the deleted node ID')
			await target.applyNodeOperations(delta.operations, (hash) => source.getBlobByHash(hash))
			assert(
				text(await targetVolume.readFile('/new/note.txt')) === 'new identity',
				'recreated content did not apply'
			)
		}
	},
	{
		name: 'a frozen snapshot hands off to later deltas',
		async run(makeBackend) {
			const sourceStorage = makeBackend()
			const targetStorage = makeBackend()
			const source = replica(sourceStorage)
			const target = replica(targetStorage)
			const sourceVolume = volume(sourceStorage)
			const targetVolume = volume(targetStorage)
			await sourceVolume.writeFile('/a.txt', bytes('a'))
			await sourceVolume.writeFile('/z.txt', bytes('old'))
			const first = await source.nodeSnapshot(undefined, { limit: 1 })
			assert(first.status === 'ok' && first.next, 'snapshot did not return a first page')
			await sourceVolume.writeFile('/z.txt', bytes('new'))

			let page = first
			for (;;) {
				await target.applyNodeOperations(page.operations, async (hash) => {
					const blob = await source.getSnapshotBlob(page.session, hash)
					if (blob.status !== 'ok') throw new Error('snapshot blob expired')
					return blob.data
				})
				if (!page.next) break
				const next = await source.nodeSnapshot(page.next, { limit: 1 })
				assert(next.status === 'ok', 'snapshot continuation restarted')
				page = next
			}
			await source.closeSnapshot(first.session)
			assert(text(await targetVolume.readFile('/z.txt')) === 'old', 'snapshot was not frozen')

			const delta = await source.nodeDeltas(first.syncCursor, { limit: 100 })
			await target.applyNodeOperations(delta.operations, (hash) => source.getBlobByHash(hash))
			assert(text(await targetVolume.readFile('/z.txt')) === 'new', 'handoff missed the update')
		}
	},
	{
		name: 'authority retries exact operations and rejects changed reuse',
		async run(makeBackend) {
			const target = authority(makeBackend())
			const create = {
				operationId: 'conformance-create',
				mutations: [
					{
						kind: 'create' as const,
						nodeId: 'conformance-node',
						parentId: ROOT_NODE_ID,
						name: 'node',
						baseRevision: 0 as const,
						revision: 1,
						meta: { type: 1 as const, mode: 0o755, mtimeNs: '0', size: '0' }
					}
				]
			}
			const first = await target.applyNodeOperations([create], () =>
				Promise.reject(new Error('directory create requested content'))
			)
			const retry = await target.applyNodeOperations([create], () =>
				Promise.reject(new Error('directory create requested content'))
			)
			assert(JSON.stringify(retry) === JSON.stringify(first), 'exact retry result changed')
			const changed = structuredClone(create)
			const changedMutation = changed.mutations[0]
			assert(changedMutation, 'create mutation is missing')
			changedMutation.name = 'other'
			const [reused] = await target.applyNodeOperations([changed], () =>
				Promise.reject(new Error('directory create requested content'))
			)
			assert(reused?.status === 'rejected' && reused.reason === 'invalid', 'reuse was accepted')
			const delta = await target.nodeDeltas('', { limit: 10 })
			assert(delta.operations.length === 1, 'retry added a journal row')
		}
	},
	{
		name: 'authority enforces revisions, names, claims, cycles, and tombstones',
		async run(makeBackend) {
			const target = authority(makeBackend())
			const dir = (operationId: string, nodeId: string, parentId: string, name: string) => ({
				operationId,
				mutations: [
					{
						kind: 'create' as const,
						nodeId,
						parentId,
						name,
						baseRevision: 0 as const,
						revision: 1,
						meta: { type: 1 as const, mode: 0o755, mtimeNs: '0', size: '0' }
					}
				]
			})
			for (const operation of [
				dir('create-a', 'a', ROOT_NODE_ID, 'a'),
				dir('create-b', 'b', ROOT_NODE_ID, 'b'),
				dir('create-source', 'source', ROOT_NODE_ID, 'source'),
				dir('create-child', 'child', 'source', 'child')
			])
				await target.applyNodeOperations([operation], () =>
					Promise.reject(new Error('directory create requested content'))
				)

			const invalidName = await target.applyNodeOperations(
				[dir('invalid-name', 'bad-name', ROOT_NODE_ID, 'e\u0301')],
				() => Promise.reject(new Error('directory create requested content'))
			)
			assert(
				invalidName[0]?.status === 'rejected' && invalidName[0].reason === 'invalid_name',
				'invalid name was accepted'
			)
			const missingParent = await target.applyNodeOperations(
				[dir('missing-parent', 'bad-parent', 'missing', 'node')],
				() => Promise.reject(new Error('directory create requested content'))
			)
			assert(
				missingParent[0]?.status === 'rejected' && missingParent[0].reason === 'invalid_parent',
				'missing parent was accepted'
			)

			const move = (operationId: string, parentId: string, name: string, baseRevision: number) => ({
				operationId,
				mutations: [
					{
						kind: 'move' as const,
						nodeId: 'source',
						parentId,
						name,
						baseRevision,
						revision: baseRevision + 1
					}
				]
			})
			const collision = await target.applyNodeOperations(
				[move('collision', ROOT_NODE_ID, 'b', 1)],
				() => Promise.reject(new Error('move requested content'))
			)
			assert(
				collision[0]?.status === 'rejected' && collision[0].reason === 'collision',
				'occupied name was accepted'
			)
			await target.applyNodeOperations([move('move-a', 'a', 'source', 1)], () =>
				Promise.reject(new Error('move requested content'))
			)
			const stale = await target.applyNodeOperations([move('move-b', 'b', 'source', 1)], () =>
				Promise.reject(new Error('move requested content'))
			)
			assert(stale[0]?.status === 'rejected' && stale[0].reason === 'stale', 'stale move won')
			const cycle = await target.applyNodeOperations([move('cycle', 'child', 'source', 2)], () =>
				Promise.reject(new Error('move requested content'))
			)
			assert(cycle[0]?.status === 'rejected' && cycle[0].reason === 'cycle', 'cycle was accepted')

			const remove = (operationId: string, nodeId: string, baseRevision: number) => ({
				operationId,
				mutations: [
					{
						kind: 'delete' as const,
						nodeId,
						baseRevision,
						revision: baseRevision + 1
					}
				]
			})
			const parentDelete = await target.applyNodeOperations(
				[remove('source-early', 'source', 2)],
				() => Promise.reject(new Error('delete requested content'))
			)
			assert(
				parentDelete[0]?.status === 'rejected' && parentDelete[0].reason === 'not_empty',
				'non-empty directory was deleted'
			)
			await target.applyNodeOperations([remove('child-delete', 'child', 1)], () =>
				Promise.reject(new Error('delete requested content'))
			)
			const deleteSource = remove('source-delete', 'source', 2)
			const acceptedDelete = await target.applyNodeOperations([deleteSource], () =>
				Promise.reject(new Error('delete requested content'))
			)
			const retryDelete = await target.applyNodeOperations([deleteSource], () =>
				Promise.reject(new Error('delete requested content'))
			)
			assert(
				JSON.stringify(retryDelete) === JSON.stringify(acceptedDelete),
				'delete retry result changed'
			)
			const deleted = await target.applyNodeOperations(
				[move('move-deleted', 'b', 'source', 3)],
				() => Promise.reject(new Error('move requested content'))
			)
			assert(
				deleted[0]?.status === 'rejected' && deleted[0].reason === 'deleted',
				'tombstone move was accepted'
			)
		}
	}
]
