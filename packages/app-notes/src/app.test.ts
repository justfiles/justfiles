import { expect, test } from 'vitest'
import { app, initialState, type NotesState } from './app.ts'

const dec = new TextDecoder()

// A stand-in for the volume capability: paths → text, dirs as a set. Only the
// methods the procedures reach for.
function fakeVolume(files: Record<string, string> = {}, dirs: string[] = []) {
	const store = new Map(Object.entries(files))
	const folders = new Set(dirs)
	const invoke = async (_cap: string, method: string, ...args: unknown[]): Promise<unknown> => {
		const path = args[0] as string
		switch (method) {
			case 'scan':
				return [
					...[...folders].map((p) => ({ path: p, type: 'dir' as const })),
					...[...store.keys()].map((p, i) => ({ path: p, type: 'file' as const, mtimeNs: i }))
				]
			case 'exists':
				return store.has(path) || folders.has(path)
			case 'writeFile':
				store.set(path, dec.decode(args[1] as Uint8Array))
				return undefined
			case 'readFile':
				return new TextEncoder().encode(store.get(path) ?? '')
			case 'mkdir':
				folders.add(path)
				return undefined
			case 'rm':
				for (const key of store.keys()) {
					if (key === path || key.startsWith(`${path}/`)) store.delete(key)
				}
				folders.delete(path)
				return undefined
			default:
				throw new Error(`unexpected volume.${method}`)
		}
	}
	return { store, folders, invoke }
}

function handle(state: NotesState, invoke: ReturnType<typeof fakeVolume>['invoke']) {
	const dispatched: string[] = []
	return {
		dispatched,
		app: {
			state,
			invoke,
			dispatch: async (message: { type: string }) => {
				dispatched.push(message.type)
				return { seq: 1 }
			},
			settled: async () => state
		} as never
	}
}

test('watches the tree always, and the open file when there is one', () => {
	const tree = {
		capability: 'volume',
		method: 'watch',
		args: [{ path: '/', recursive: true }],
		to: 'treeChanged'
	}
	expect(app.subscriptions(initialState)).toEqual([tree])
	expect(app.subscriptions({ ...initialState, openPath: '/Trips/Kyoto.md' })).toEqual([
		tree,
		{
			capability: 'volume',
			method: 'watch',
			args: [{ path: '/Trips/Kyoto.md' }],
			to: 'fileChanged'
		}
	])
})

test('on-disk changes bump their own counter, and nothing else', async () => {
	const file = await app.dispatch(
		{ type: '__sub/fileChanged', params: {} },
		{ state: initialState }
	)
	expect(file.state).toMatchObject({ revision: 1, treeRevision: 0 })
	const tree = await app.dispatch(
		{ type: '__sub/treeChanged', params: {} },
		{ state: initialState }
	)
	expect(tree.state).toMatchObject({ revision: 0, treeRevision: 1 })
})

test('rename follows the open note, including when its folder is the thing moved', async () => {
	const open = { ...initialState, openPath: '/Groceries.md' }
	const renamed = await app.dispatch(
		{ type: 'rename', params: { from: '/Groceries.md', to: '/Lists/Shopping list.md' } },
		{ state: open }
	)
	expect(renamed.state?.openPath).toBe('/Lists/Shopping list.md')

	const nested = { ...initialState, openPath: '/Trips/Kyoto.md' }
	const moved = await app.dispatch(
		{ type: 'rename', params: { from: '/Trips', to: '/Travel/Japan' } },
		{ state: nested }
	)
	expect(moved.state?.openPath).toBe('/Travel/Japan/Kyoto.md')

	// An unrelated move leaves the open note alone.
	const other = await app.dispatch(
		{ type: 'rename', params: { from: '/Groceries.md', to: '/Lists/Groceries.md' } },
		{ state: nested }
	)
	expect(other.state?.openPath).toBe('/Trips/Kyoto.md')
})

test('list walks nested folders, keeps .md and .txt, and returns folders too', async () => {
	const vol = fakeVolume(
		{
			'/Trips/Kyoto.md': 'Kyoto',
			'/Groceries.txt': 'eggs',
			'/Attachments/Engelbart.jpg': 'binary',
			'/Map.base': 'yaml'
		},
		['/Trips', '/Attachments', '/Empty']
	)
	const entries = (await app.runProcedure(
		'list',
		{},
		handle(initialState, vol.invoke).app
	)) as Array<{ path: string; type: string; title: string }>

	expect(entries.filter((e) => e.type === 'file').map((e) => e.path)).toEqual([
		'/Groceries.txt',
		'/Trips/Kyoto.md'
	])
	expect(entries.filter((e) => e.type === 'dir').map((e) => e.path)).toEqual([
		'/Trips',
		'/Attachments',
		'/Empty'
	])
	expect(entries.find((e) => e.path === '/Trips/Kyoto.md')?.title).toBe('Kyoto')
})

test('create names the file after the first line, in the folder asked for', async () => {
	const vol = fakeVolume()
	const h = handle(initialState, vol.invoke)
	await app.runProcedure('create', { text: 'Remember the milk\nand eggs' }, h.app)
	expect([...vol.store.keys()]).toEqual(['/Remember the milk.md'])

	await app.runProcedure('create', { text: 'Kyoto', dir: '/Trips' }, h.app)
	expect(vol.store.has('/Trips/Kyoto.md')).toBe(true)

	// A second note with the same first line gets a numbered sibling, not a clobber.
	await app.runProcedure('create', { text: 'Kyoto', dir: '/Trips' }, h.app)
	expect(vol.store.has('/Trips/Kyoto 2.md')).toBe(true)
	expect(h.dispatched).toEqual(['open', 'open', 'open'])
})

test('removing the folder the open note lives in clears the editor', async () => {
	const vol = fakeVolume({ '/Trips/Kyoto.md': 'Kyoto' }, ['/Trips'])
	const h = handle({ ...initialState, openPath: '/Trips/Kyoto.md' }, vol.invoke)
	await app.runProcedure('remove', { path: '/Trips' }, h.app)
	expect(vol.store.size).toBe(0)
	expect(h.dispatched).toEqual(['newNote'])
})
