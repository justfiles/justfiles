import { volume } from '@justfiles/fs'
import type { Storage } from '@justfiles/fs/storage'
import { mutationsOf, type NodeReplica } from './node'
import { storageSyncReplica } from './strategy'

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value)
const text = (value: Uint8Array): string => new TextDecoder().decode(value)

function replica(storage: Storage): NodeReplica {
	const selected = storageSyncReplica(storage)
	if (selected.strategy !== 'incremental') throw new Error('expected incremental sync')
	return selected.replica
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
	}
]
