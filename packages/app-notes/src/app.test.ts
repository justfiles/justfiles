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
			case 'writeFile': {
				// Models the contract: `exclusive` is a claim, so a taken name throws
				// rather than overwriting (packages/fs/volume.ts).
				const exclusive = (args[2] as { exclusive?: boolean } | undefined)?.exclusive
				if (exclusive && store.has(path)) throw new Error(`EEXIST: ${path}`)
				if (exclusive && folders.has(path)) throw new Error(`EISDIR: ${path}`)
				store.set(path, dec.decode(args[1] as Uint8Array))
				return undefined
			}
			case 'readFile':
				return new TextEncoder().encode(store.get(path) ?? '')
			case 'mkdir':
				folders.add(path)
				return undefined
			case 'rename': {
				const to = args[1] as string
				store.delete(to) // POSIX replace — including the placeholder `rename` claims
				for (const [key, value] of [...store]) {
					if (key === path) {
						store.delete(key)
						store.set(to, value)
					} else if (key.startsWith(`${path}/`)) {
						store.delete(key)
						store.set(`${to}${key.slice(path.length)}`, value)
					}
				}
				if (folders.delete(path)) folders.add(to)
				return undefined
			}
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

test('state persisted before the revision counters existed still counts up', async () => {
	// `init` is not re-merged into stored state (docs/app.md §3), so an upgraded
	// install has neither counter. `undefined + 1` would pin them at NaN — the
	// tree would refresh once and then never again.
	const legacy = { openPath: null, error: null } as NotesState
	const tree = await app.dispatch({ type: '__sub/treeChanged', params: {} }, { state: legacy })
	expect(tree.state?.treeRevision).toBe(1)
	const file = await app.dispatch({ type: '__sub/fileChanged', params: {} }, { state: legacy })
	expect(file.state?.revision).toBe(1)
})

test('rename never overwrites: an occupied destination is numbered instead', async () => {
	const vol = fakeVolume({ '/Groceries.md': 'mine', '/Lists/Groceries.md': 'theirs' }, ['/Lists'])
	const h = handle(initialState, vol.invoke)
	// `volume.rename` replaces the destination (POSIX), so a drag into a folder
	// that already holds the same name would destroy a note.
	const result = (await app.runProcedure(
		'rename',
		{ from: '/Groceries.md', to: '/Lists/Groceries.md' },
		h.app
	)) as { path: string }
	expect(result.path).toBe('/Lists/Groceries 2.md')
	expect(vol.store.get('/Lists/Groceries.md')).toBe('theirs')
	expect(vol.store.get('/Lists/Groceries 2.md')).toBe('mine')
	expect(h.dispatched).toEqual(['moved'])
})

test('renaming to where it already is does nothing at all', async () => {
	const vol = fakeVolume({ '/Kyoto.md': 'x' })
	const h = handle(initialState, vol.invoke)
	const result = (await app.runProcedure(
		'rename',
		{ from: '/Kyoto.md', to: '/Kyoto.md' },
		h.app
	)) as { path: string }
	expect(result.path).toBe('/Kyoto.md')
	expect(h.dispatched).toEqual([])
})

test('a move follows the open note, including when its folder is the thing moved', async () => {
	const open = { ...initialState, openPath: '/Groceries.md' }
	const renamed = await app.dispatch(
		{ type: 'moved', params: { from: '/Groceries.md', to: '/Lists/Shopping list.md' } },
		{ state: open }
	)
	expect(renamed.state?.openPath).toBe('/Lists/Shopping list.md')

	const nested = { ...initialState, openPath: '/Trips/Kyoto.md' }
	const moved = await app.dispatch(
		{ type: 'moved', params: { from: '/Trips', to: '/Travel/Japan' } },
		{ state: nested }
	)
	expect(moved.state?.openPath).toBe('/Travel/Japan/Kyoto.md')

	// An unrelated move leaves the open note alone.
	const other = await app.dispatch(
		{ type: 'moved', params: { from: '/Groceries.md', to: '/Lists/Groceries.md' } },
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

test('importNotes merges into the knowledge base root, with names untouched', async () => {
	const vol = fakeVolume()
	const h = handle(initialState, vol.invoke)
	const result = (await app.runProcedure(
		'importNotes',
		{
			files: [
				{ path: 'Trips/Kyōto trip.md', text: 'x' },
				{ path: 'Groceries.txt', text: 'eggs' }
			]
		},
		h.app
	)) as { written: number; renamed: number }

	expect(result).toEqual({ written: 2, renamed: 0 })
	// No wrapper folder: the vault's own structure IS the structure. Names are
	// verbatim — spaces, case and non-ASCII survive, because wikilinks address
	// notes by their exact filename.
	expect([...vol.store.keys()].sort()).toEqual(['/Groceries.txt', '/Trips/Kyōto trip.md'])
})

test('an imported note never overwrites an existing one — it lands beside it', async () => {
	const vol = fakeVolume({ '/Trips/Kyoto.md': 'mine', '/Osaka.md': 'mine' }, ['/Trips'])
	const h = handle(initialState, vol.invoke)
	const result = (await app.runProcedure(
		'importNotes',
		{
			files: [
				{ path: 'Trips/Kyoto.md', text: 'theirs' },
				{ path: 'Trips/Nara.md', text: 'theirs' },
				{ path: 'Osaka.md', text: 'theirs' }
			]
		},
		h.app
	)) as { written: number; renamed: number }

	expect(result).toEqual({ written: 3, renamed: 2 })
	// The clash is numbered before the extension, and the folder simply merges.
	expect(vol.store.get('/Trips/Kyoto.md')).toBe('mine')
	expect(vol.store.get('/Trips/Kyoto 2.md')).toBe('theirs')
	expect(vol.store.get('/Osaka 2.md')).toBe('theirs')
	expect(vol.store.get('/Trips/Nara.md')).toBe('theirs')
})

test('importNotes can be aimed at a folder', async () => {
	const vol = fakeVolume()
	const h = handle(initialState, vol.invoke)
	await app.runProcedure(
		'importNotes',
		{ dir: '/Archive', files: [{ path: 'Old/Note.md', text: 'x' }] },
		h.app
	)
	expect([...vol.store.keys()]).toEqual(['/Archive/Old/Note.md'])
})

test('rename refuses to strand a folder inside itself', async () => {
	const vol = fakeVolume({ '/Trips/Kyoto.md': 'x' }, ['/Trips'])
	const h = handle(initialState, vol.invoke)
	await expect(
		app.runProcedure('rename', { from: '/Trips', to: '/Trips/Archive/Trips' }, h.app)
	).rejects.toThrow(/inside itself/)
	// Nothing moved, and nothing was dispatched — the guard is before the write.
	expect([...vol.store.keys()]).toEqual(['/Trips/Kyoto.md'])
	expect(h.dispatched).toEqual([])
})

test('dot segments are refused everywhere, so no lexical path check can be fooled', async () => {
	const vol = fakeVolume({ '/Trips/Kyoto.md': 'x' }, ['/Trips'])
	const h = handle(initialState, vol.invoke)
	// `/Other/../Trips/Sub` is not under `/Trips` lexically, but it is the moment the
	// volume resolves it — which would strand /Trips inside itself.
	await expect(
		app.runProcedure('rename', { from: '/Trips', to: '/Other/../Trips/Sub' }, h.app)
	).rejects.toThrow()
	await expect(app.runProcedure('create', { text: 'x', dir: '/..' }, h.app)).rejects.toThrow()
	await expect(app.runProcedure('readNote', { path: '/a/./b.md' }, h.app)).rejects.toThrow()
	// Nothing moved, nothing written.
	expect([...vol.store.keys()]).toEqual(['/Trips/Kyoto.md'])
})

test('an import of same-named notes keeps both, numbering the second', async () => {
	const vol = fakeVolume()
	const h = handle(initialState, vol.invoke)
	const result = (await app.runProcedure(
		'importNotes',
		{
			files: [
				{ path: 'Kyoto.md', text: 'first' },
				{ path: 'Kyoto.md', text: 'second' }
			]
		},
		h.app
	)) as { written: number; renamed: number }
	expect(result).toEqual({ written: 2, renamed: 1 })
	expect(vol.store.get('/Kyoto.md')).toBe('first')
	expect(vol.store.get('/Kyoto 2.md')).toBe('second')
})
