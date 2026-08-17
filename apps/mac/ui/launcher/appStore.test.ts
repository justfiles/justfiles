import { expect, test } from 'vitest'
import { storeRows } from './appStore'

const tasks = { id: 'com.example.tasks', name: 'Tasks', version: '1.0.0' }
const notes = {
	id: 'justfiles.notes',
	name: 'Notes',
	version: '2.0.0',
	capabilities: { volume: { id: 'volume', scopes: ['read', 'write'] } }
}

test('lists what is not installed', () => {
	expect(storeRows([tasks], [])).toEqual([{ app: tasks, kind: 'install' }])
	expect(storeRows([tasks], [{ id: tasks.id, version: '1.0.0' }])).toEqual([])
})

test('offers a held update — a newer version asking for more access — and leads with it', () => {
	const installed = [
		{ id: notes.id, version: '1.0.0', capabilities: { volume: { id: 'volume', scopes: ['read'] } } }
	]
	expect(storeRows([tasks, notes], installed)).toEqual([
		{ app: notes, kind: 'update' },
		{ app: tasks, kind: 'install' }
	])

	// A release replaced in place asks for more under the SAME version: reconcile holds that
	// too, and this list is the only place to grant it.
	expect(
		storeRows(
			[notes],
			[
				{
					id: notes.id,
					version: notes.version,
					capabilities: { volume: { id: 'volume', scopes: ['read'] } }
				}
			]
		)
	).toEqual([{ app: notes, kind: 'update' }])

	// Same access, or a version the store has rolled BACK from: nothing to consent to.
	expect(
		storeRows([notes], [{ id: notes.id, version: '1.0.0', capabilities: notes.capabilities }])
	).toEqual([])
	expect(storeRows([notes], [{ id: notes.id, version: '3.0.0' }])).toEqual([])
})
