import { expect, test } from 'vitest'
import { app, initialState, type NotesState } from './app.ts'

const dec = new TextDecoder()

// A stand-in for the volume capability: paths → text, dirs as a set. Only the
// methods the procedures reach for.
// `failOn`: a path the volume refuses to write, so a test can put one bad name in the
// middle of a batch (a real one would be ENOSPC, or a name the OS rejects).
function fakeVolume(files: Record<string, string> = {}, dirs: string[] = [], failOn?: RegExp) {
	const store = new Map(Object.entries(files))
	const folders = new Set(dirs)
	const invoke = async (_cap: string, method: string, ...args: unknown[]): Promise<unknown> => {
		const path = args[0] as string
		switch (method) {
			case 'scan': {
				// Models the contract: scanning something that is not a directory is ENOTDIR,
				// which is how the app asks "is this a folder?" without a type constant.
				const at = (args[0] as { path: string }).path
				if (at !== '/' && !folders.has(at)) {
					throw new Error(store.has(at) ? `ENOTDIR: ${at}` : `ENOENT: ${at}`)
				}
				return [
					...[...folders].map((p) => ({ path: p, type: 'dir' as const })),
					...[...store.keys()].map((p, i) => ({ path: p, type: 'file' as const, mtimeNs: i }))
				]
			}
			case 'exists':
				return store.has(path) || folders.has(path)
			case 'writeFile': {
				// Models the contract: `exclusive` is a claim, so a taken name throws
				// rather than overwriting (packages/fs/volume.ts).
				const opts = args[2] as
					| { exclusive?: boolean; update?: boolean; parents?: boolean }
					| undefined
				const exclusive = opts?.exclusive
				if (failOn?.test(path)) throw new Error(`EACCES: ${path}`)
				if (exclusive && store.has(path)) throw new Error(`EEXIST: ${path}`)
				if (exclusive && folders.has(path)) throw new Error(`EISDIR: ${path}`)
				// `update` is an edit: there has to be something to edit (see volume.ts).
				if (opts?.update && !store.has(path)) throw new Error(`ENOENT: ${path}`)
				// `parents: false` declines the host's folder-creating convenience, so the
				// parent has to exist already (see capabilities/volume/contract.ts).
				const parent = path.slice(0, path.lastIndexOf('/')) || '/'
				if (opts?.parents === false && parent !== '/' && !folders.has(parent))
					throw new Error(`ENOENT: ${parent}`)
				// Otherwise the host creates them, which is what an import relies on.
				for (let at = parent; at !== '/' && at !== ''; at = at.slice(0, at.lastIndexOf('/')))
					folders.add(at)
				store.set(path, dec.decode(args[1] as Uint8Array))
				return undefined
			}
			case 'readFile': {
				// The volume's own answers: a folder is EISDIR, a missing note ENOENT — which
				// is what `readNote` relies on instead of probing (see app.ts).
				if (folders.has(path)) throw new Error(`EISDIR: ${path}`)
				const body = store.get(path)
				if (body === undefined) throw new Error(`ENOENT: ${path}`)
				return new TextEncoder().encode(body)
			}
			case 'mkdir':
				// Models the contract: `mkdir -p` passes over a component that is already a
				// directory, never over a file (packages/fs/volume.ts).
				if (store.has(path)) throw new Error(`EEXIST: ${path}`)
				folders.add(path)
				return undefined
			case 'rename': {
				const to = args[1] as string
				// Models the contract: POSIX replace, with no flag to soften it (packages/fs/volume.ts).
				// Refusing a taken name is the APP's job now, so the double must not do it here —
				// a double that refused would hide the very check `claimPath` is responsible for.
				//
				// The yield is load-bearing: the app probes and then moves, so a claim can only be
				// overtaken between those two steps. Without it this double is accidentally atomic
				// and a test about ordering asserts nothing.
				await Promise.resolve()
				store.delete(to)
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

function handle(
	state: NotesState,
	invoke: ReturnType<typeof fakeVolume>['invoke'],
	// Models the contract: `settled(seq)` resolves with the state after the per-app queue
	// DRAINS, which can include another client's `open` — it orders, it does not answer.
	settledAs: NotesState = state
) {
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
			settled: async () => settledAs
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

test('a save cannot bring a note — or its folder — back from the dead, and it THROWS', async () => {
	// The agent renames /Trips while /Trips/Kyoto.md is open: `openPath` still says the
	// old path (no watch can tell us — see app.ts), and a plain write would rebuild
	// /Trips and leave a stale duplicate in it.
	const vol = fakeVolume({ '/Journeys/Kyoto.md': 'moved here' }, ['/Journeys'])
	const h = handle({ ...initialState, openPath: '/Trips/Kyoto.md' }, vol.invoke)
	// A procedure, so the caller learns this while it still holds the text that failed
	// to land — an edge would report it after the next transition (see gui.tsx `flush`).
	await expect(
		app.runProcedure('save', { path: '/Trips/Kyoto.md', text: 'edited while it moved' }, h.app)
	).rejects.toThrow(/ENOENT/)
	// Nothing was created: no note, and no folder to hold it.
	expect([...vol.store.keys()]).toEqual(['/Journeys/Kyoto.md'])
	// A save of a note that IS there still just saves.
	await app.runProcedure('save', { path: '/Journeys/Kyoto.md', text: 'edited' }, h.app)
	expect(vol.store.get('/Journeys/Kyoto.md')).toBe('edited')
})

test('a create will not rebuild the folder it was aimed at', async () => {
	// The GUI picks the folder from its listing, which is a snapshot: the agent can have
	// deleted it a moment ago. `parents: false` makes that an error instead of a folder
	// quietly coming back around the new note (the GUI then saves it at the top level).
	const vol = fakeVolume({}, ['/Trips'])
	const h = handle(initialState, vol.invoke)
	await app.runProcedure('create', { text: 'Kyoto', dir: '/Trips' }, h.app)
	expect([...vol.store.keys()]).toEqual(['/Trips/Kyoto.md'])
	await expect(app.runProcedure('create', { text: 'Osaka', dir: '/Gone' }, h.app)).rejects.toThrow(
		/ENOENT/
	)
	expect([...vol.store.keys()]).toEqual(['/Trips/Kyoto.md'])
	// An IMPORT still creates its folders — that is what an import is for.
	await app.runProcedure('importNotes', { files: [{ path: 'New/Nara.md', text: 'x' }] }, h.app)
	expect([...vol.store.keys()].sort()).toEqual(['/New/Nara.md', '/Trips/Kyoto.md'])
})

test('concurrent renames to one name are ordered, not raced', async () => {
	// The kernel runs procedures off its per-app queue, so a GUI drag and an agent call
	// really can overlap. The move's claim is two steps (check, then move — no POSIX
	// rename is both atomic and no-replace), so the app orders them instead: both notes
	// survive, one numbered, and neither reports a success it did not have.
	const vol = fakeVolume({ '/A/Kyoto.md': 'from A', '/B/Kyoto.md': 'from B' }, ['/A', '/B'])
	const h = handle(initialState, vol.invoke)
	const landed = (await Promise.all([
		app.runProcedure('rename', { from: '/A/Kyoto.md', to: '/Kyoto.md' }, h.app),
		app.runProcedure('rename', { from: '/B/Kyoto.md', to: '/Kyoto.md' }, h.app)
	])) as Array<{ path: string }>
	expect(landed.map((r) => r.path).sort()).toEqual(['/Kyoto 2.md', '/Kyoto.md'])
	expect([...vol.store.keys()].sort()).toEqual(['/Kyoto 2.md', '/Kyoto.md'])
	expect([vol.store.get('/Kyoto.md'), vol.store.get('/Kyoto 2.md')].sort()).toEqual([
		'from A',
		'from B'
	])
})

test('an import racing a move cannot have its note replaced', async () => {
	// Mixing the two ways of taking a name is the dangerous case: the move probes a free
	// destination, the import claims it with an exclusive create, and the move's rename then
	// lands on top while both callers report success. `packages/fs` cannot prevent it — POSIX
	// rename replaces — so `claimPath` puts both on one chain, and this is the test that fails
	// if that chain goes away.
	const vol = fakeVolume({ '/A/Kyoto.md': 'the moved one' }, ['/A'])
	const h = handle(initialState, vol.invoke)
	const [moved, imported] = (await Promise.all([
		app.runProcedure('rename', { from: '/A/Kyoto.md', to: '/Kyoto.md' }, h.app),
		app.runProcedure(
			'importNotes',
			{ files: [{ path: 'Kyoto.md', text: 'the imported one' }] },
			h.app
		)
	])) as [{ path: string }, { written: number }]
	expect(imported.written).toBe(1)
	// Both survive, whichever got there first, and neither body was overwritten.
	expect([...vol.store.values()].sort()).toEqual(['the imported one', 'the moved one'])
	expect([...vol.store.keys()].sort()).toEqual(['/Kyoto 2.md', '/Kyoto.md'])
	expect(moved.path).toMatch(/^\/Kyoto( 2)?\.md$/)
})

test('a rename keeps a note a note, and an import member has to be one', async () => {
	// `/Groceries.md` → `/Shopping` moved the file happily and then it was invisible:
	// `list` filters it out, `readNote`/`save` refuse it. The extension the source had
	// is carried over, in the procedure, so the tree menu and the agent agree.
	const vol = fakeVolume({ '/Groceries.md': 'eggs', '/Notes.txt': 'plain' }, [])
	const h = handle(initialState, vol.invoke)
	expect(
		(
			(await app.runProcedure('rename', { from: '/Groceries.md', to: '/Shopping' }, h.app)) as {
				path: string
			}
		).path
	).toBe('/Shopping.md')
	expect(
		(
			(await app.runProcedure('rename', { from: '/Notes.txt', to: '/Plain' }, h.app)) as {
				path: string
			}
		).path
	).toBe('/Plain.txt')
	// A folder keeps whatever was typed — it is not a note and never was.
	await app.runProcedure('mkdir', { path: '/Trips' }, h.app)
	expect(
		(
			(await app.runProcedure('rename', { from: '/Trips', to: '/Journeys' }, h.app)) as {
				path: string
			}
		).path
	).toBe('/Journeys')
	// And an import cannot smuggle in a file the app could never show.
	await expect(
		app.runProcedure('importNotes', { files: [{ path: 'image.png', text: 'binary-ish' }] }, h.app)
	).rejects.toThrow()
})

test('a folder that looks like a note is refused by the read, not by its name', async () => {
	// `Archive.md` is a directory. No spelling rule can tell it from a note, so the read
	// is the check — and the GUI turns the failure into "cannot open", detaching.
	const vol = fakeVolume({ '/Archive.md/Kyoto.md': 'inside' }, ['/Archive.md'])
	const h = handle(initialState, vol.invoke)
	await expect(app.runProcedure('readNote', { path: '/Archive.md' }, h.app)).rejects.toThrow(
		/EISDIR/
	)
	// And a note that is simply gone says so, instead of reading as an empty note that
	// the editor would then save over whatever the path has become.
	await expect(app.runProcedure('readNote', { path: '/Gone.md' }, h.app)).rejects.toThrow(/ENOENT/)
})

test('create answers with the note it wrote, not with whatever is open when the queue drains', async () => {
	// Another client dispatching `open` while this create settles must not rename the bytes
	// we just wrote: the caller would then save the user's next keystrokes into someone
	// else's note.
	const vol = fakeVolume({}, [])
	const h = handle(initialState, vol.invoke, { openPath: '/Someone elses note.md' })
	const result = (await app.runProcedure('create', { text: 'Kyoto' }, h.app)) as { path: string }
	expect(result.path).toBe('/Kyoto.md')
	expect([...vol.store.keys()]).toEqual(['/Kyoto.md'])
})

test('a folder that is spelled like a note still renames like a folder', async () => {
	// `/Archive.md` is a DIRECTORY. Preserving "its extension" would rename it to the name
	// it already has — a move that silently does nothing.
	const vol = fakeVolume({ '/Archive.md/Kyoto.md': 'inside' }, ['/Archive.md'])
	const h = handle(initialState, vol.invoke)
	const result = (await app.runProcedure(
		'rename',
		{ from: '/Archive.md', to: '/Archive' },
		h.app
	)) as { path: string }
	expect(result.path).toBe('/Archive')
	expect([...vol.store.keys()]).toEqual(['/Archive/Kyoto.md'])
})

test('a folder is not created where a note already sits', async () => {
	// `mkdir -p` used to walk past an existing final component without looking at what it
	// is, so this reported success and created nothing. The refusal belongs to `mkdir`
	// itself (packages/fs/volume.ts) — a check here can be overtaken by the import.
	const vol = fakeVolume({ '/Kyoto.md': 'note' }, [])
	const h = handle(initialState, vol.invoke)
	await expect(app.runProcedure('mkdir', { path: '/Kyoto.md' }, h.app)).rejects.toThrow(/EEXIST/)
	// An existing folder is fine (idempotent), and a free name is created.
	await app.runProcedure('mkdir', { path: '/Trips' }, h.app)
	await app.runProcedure('mkdir', { path: '/Trips' }, h.app)
	expect([...vol.folders]).toContain('/Trips')
})

test('a folder cannot be opened as a note', async () => {
	// `list` returns folders, so the agent can hand one back. Refused at the schema:
	// the editor pointing at a directory has nothing to show and no way out.
	const vol = fakeVolume({ '/Trips/Kyoto.md': 'x' }, ['/Trips'])
	const h = handle(initialState, vol.invoke)
	await expect(
		app.dispatch({ type: 'open', params: { path: '/Trips' } }, { state: initialState })
	).rejects.toThrow()
	await expect(app.runProcedure('readNote', { path: '/Trips' }, h.app)).rejects.toThrow()
	// A folder is still a fine thing to move or delete.
	await app.runProcedure('rename', { from: '/Trips', to: '/Journeys' }, h.app)
	expect([...vol.store.keys()]).toEqual(['/Journeys/Kyoto.md'])
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

test('a folder moved onto an occupied name is numbered, not merged or replaced', async () => {
	// The destination policy is one loop over one primitive, so it holds for folders
	// too — and the primitive is the move itself, so there is no placeholder to be of
	// the wrong type (a file placeholder made every folder move fail with ENOTDIR).
	const vol = fakeVolume({ '/Trips/Kyoto.md': 'mine', '/Archive/Trips/Old.md': 'theirs' }, [
		'/Trips',
		'/Archive',
		'/Archive/Trips'
	])
	const h = handle(initialState, vol.invoke)
	const result = (await app.runProcedure(
		'rename',
		{ from: '/Trips', to: '/Archive/Trips' },
		h.app
	)) as { path: string }
	expect(result.path).toBe('/Archive/Trips 2')
	expect(vol.store.get('/Archive/Trips/Old.md')).toBe('theirs')
	expect(vol.store.get('/Archive/Trips 2/Kyoto.md')).toBe('mine')
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

test('the trail records where THIS note has been, so a client can follow from wherever it is', async () => {
	// A client sees state, not each transition. Of two renames it may have followed the
	// first and missed the second, or missed both — so a single "previous address" answers
	// only one of those, and either way the buffer ends up settling at a vanished path,
	// detaching on ENOENT, and forking a duplicate.
	const move = (state: NotesState, from: string, to: string) =>
		app
			.dispatch({ type: 'moved', params: { from, to } }, { state })
			.then((r) => r.state as NotesState)

	let state = await move({ ...initialState, openPath: '/Trips/Kyoto.md' }, '/Trips', '/Travel')
	expect(state).toMatchObject({ openPath: '/Travel/Kyoto.md', movedFrom: ['/Trips/Kyoto.md'] })

	state = await move(state, '/Shopping.md', '/Lists/Shopping.md') // nothing to do with us
	expect(state).toMatchObject({ openPath: '/Travel/Kyoto.md', movedFrom: ['/Trips/Kyoto.md'] })

	// Moved again: BOTH addresses answer, because either could be the one a client holds.
	state = await move(state, '/Travel/Kyoto.md', '/Travel/Kyoto trip.md')
	expect(state).toMatchObject({
		openPath: '/Travel/Kyoto trip.md',
		movedFrom: ['/Trips/Kyoto.md', '/Travel/Kyoto.md']
	})

	// A trail, not a log.
	for (let i = 0; i < 20; i++) state = await move(state, state.openPath as string, `/Kyoto ${i}.md`)
	expect(state.movedFrom).toHaveLength(8)
	expect(state.movedFrom?.at(-1)).toBe('/Kyoto 18.md')

	// Opening anything settles the question.
	const opened = await app.dispatch({ type: 'open', params: { path: '/Kyoto 19.md' } }, { state })
	expect(opened.state?.movedFrom).toBeUndefined()
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
	// `/Trips` has to exist: a create will not rebuild a folder (see the test above).
	const vol = fakeVolume({}, ['/Trips'])
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
	// The procedure reports the deletion; whether it clears the editor is the reducer's
	// call, made against the state at that moment.
	expect(h.dispatched).toEqual(['deleted'])

	const cleared = await app.dispatch(
		{ type: 'deleted', params: { path: '/Trips' } },
		{ state: { ...initialState, openPath: '/Trips/Kyoto.md' } }
	)
	expect(cleared.state?.openPath).toBeNull()

	// A selection somebody moved elsewhere while `rm` was in flight is NOT cleared…
	const elsewhere = await app.dispatch(
		{ type: 'deleted', params: { path: '/Trips' } },
		{ state: { ...initialState, openPath: '/Groceries.md' } }
	)
	expect(elsewhere.state?.openPath).toBe('/Groceries.md')

	// …and one opened UNDER the doomed folder in that window is, which a snapshot taken
	// before the delete could not have known.
	const under = await app.dispatch(
		{ type: 'deleted', params: { path: '/Trips' } },
		{ state: { ...initialState, openPath: '/Trips/Osaka.md' } }
	)
	expect(under.state?.openPath).toBeNull()
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
	)) as { written: number; renamed: number; failed: number }

	expect(result).toEqual({ written: 2, renamed: 0, failed: 0 })
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
	)) as { written: number; renamed: number; failed: number }

	expect(result).toEqual({ written: 3, renamed: 2, failed: 0 })
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

test('only the canonical spelling of a path is accepted, so no lexical check can be fooled', async () => {
	const vol = fakeVolume({ '/Trips/Kyoto.md': 'x' }, ['/Trips'])
	const h = handle(initialState, vol.invoke)
	// Each of these is the SAME move — /Trips into its own subtree — written so that a
	// lexical `isUnder` says no while the volume, which normalizes first, says yes.
	for (const from of ['/Trips/', '//Trips', '/Trips/.']) {
		await expect(app.runProcedure('rename', { from, to: '/Trips/Sub' }, h.app)).rejects.toThrow()
	}
	await expect(
		app.runProcedure('rename', { from: '/Trips', to: '/Other/../Trips/Sub' }, h.app)
	).rejects.toThrow()
	// Every path parameter inherits the rule, whatever the procedure does with it.
	await expect(app.runProcedure('create', { text: 'x', dir: '/..' }, h.app)).rejects.toThrow()
	await expect(app.runProcedure('create', { text: 'x', dir: '/Trips/' }, h.app)).rejects.toThrow()
	await expect(app.runProcedure('readNote', { path: '/a/./b.md' }, h.app)).rejects.toThrow()
	await expect(app.runProcedure('mkdir', { path: '//New' }, h.app)).rejects.toThrow()
	await expect(app.runProcedure('remove', { path: '/Trips//Kyoto.md' }, h.app)).rejects.toThrow()
	// Nothing moved, nothing written.
	expect([...vol.store.keys()]).toEqual(['/Trips/Kyoto.md'])
})

test('one unwritable note does not abandon the batch', async () => {
	// An import writes as it goes, so throwing on the first bad name would report a
	// chunk of 50 as a total failure and lose the count of what already landed.
	const vol = fakeVolume({}, [], /Broken/)
	const h = handle(initialState, vol.invoke)
	const result = (await app.runProcedure(
		'importNotes',
		{
			files: [
				{ path: 'Kyoto.md', text: 'first' },
				{ path: 'Broken.md', text: 'nope' },
				{ path: 'Osaka.md', text: 'third' }
			]
		},
		h.app
	)) as { written: number; renamed: number; failed: number }
	expect(result).toEqual({ written: 2, renamed: 0, failed: 1 })
	expect([...vol.store.keys()].sort()).toEqual(['/Kyoto.md', '/Osaka.md'])
})

test('the root is refused wherever an entry is named', async () => {
	const vol = fakeVolume({ '/Kyoto.md': 'mine' }, ['/Trips'])
	const h = handle(initialState, vol.invoke)
	// Deleting "everything" is not a note operation: it would take the whole KB.
	await expect(app.runProcedure('remove', { path: '/' }, h.app)).rejects.toThrow()
	await expect(app.runProcedure('open', { path: '/' }, h.app)).rejects.toThrow()
	await expect(app.runProcedure('rename', { from: '/', to: '/Trips' }, h.app)).rejects.toThrow()
	// An empty import member joins to the root, so it names no note either — it used to
	// be claimed as `/ 2`, an invisible file the listing does not even show.
	await expect(
		app.runProcedure('importNotes', { files: [{ path: '', text: 'nowhere' }] }, h.app)
	).rejects.toThrow()
	// But the root is still a fine PLACE to put something.
	await app.runProcedure('create', { text: 'Osaka', dir: '/' }, h.app)
	expect([...vol.store.keys()].sort()).toEqual(['/Kyoto.md', '/Osaka.md'])
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
	)) as { written: number; renamed: number; failed: number }
	expect(result).toEqual({ written: 2, renamed: 1, failed: 0 })
	expect(vol.store.get('/Kyoto.md')).toBe('first')
	expect(vol.store.get('/Kyoto 2.md')).toBe('second')
})
