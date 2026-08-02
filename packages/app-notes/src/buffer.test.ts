/**
 * The buffer's rules, as tests. Every one of these was a defect first (DESIGN.md §1a‴),
 * which is the argument for the machine existing at all: the rules used to be spread
 * across eight call sites, so each new failure mode was a new branch to remember.
 */

import { expect, test } from 'vitest'
import { type BufferIO, createBuffer } from './buffer.ts'

// A volume double with a queue of scripted failures and a record of every call. `hold`
// lets a test keep a write in flight while it does something else — which is where the
// interesting bugs were.
function fakeIO(disk: Record<string, string> = {}) {
	const calls: string[] = []
	let hold: { promise: Promise<void>; release: () => void } | null = null
	const failures: Array<Error | null> = []
	const io: BufferIO = {
		async save(path, text) {
			calls.push(`save ${path}`)
			if (hold) await hold.promise
			const failure = failures.shift()
			if (failure) throw failure
			// A save EDITS: the real one asks for `update: true`, so a note that is not there
			// is ENOENT rather than a file conjured at that path (DESIGN.md §1a‴).
			if (disk[path] === undefined) throw new Error(`ENOENT: ${path}`)
			disk[path] = text
		},
		async create(text) {
			calls.push('create')
			if (hold) await hold.promise
			const failure = failures.shift()
			if (failure) throw failure
			const name = `/${text.split('\n')[0]}.md`
			const path = disk[name] === undefined ? name : `/${text.split('\n')[0]} 2.md`
			disk[path] = text
			return path
		},
		async read(path) {
			calls.push(`read ${path}`)
			if (hold) await hold.promise
			const failure = failures.shift()
			if (failure) throw failure
			const body = disk[path]
			if (body === undefined) throw new Error(`ENOENT: ${path}`)
			return body
		}
	}
	return {
		io,
		disk,
		calls,
		/** The next IO call fails with this error (then the queue moves on). */
		failNext(error: Error) {
			failures.push(error)
		},
		/** Freeze IO until `release()`, so a test can act while a write is in flight. */
		freeze() {
			let release!: () => void
			hold = { promise: new Promise<void>((res) => (release = res)), release }
			return () => {
				hold = null
				release()
			}
		}
	}
}

// Let a queued task reach its first `await` — the machine defers work onto its chain,
// so "while a read is in flight" needs the read to have actually started.
const inFlight = () => new Promise((resolve) => setTimeout(resolve, 0))

const buffer = (disk?: Record<string, string>) => {
	const io = fakeIO(disk)
	const states: string[] = []
	const buf = createBuffer(io.io, (s) =>
		states.push(`${s.path ?? '(scratch)'}${s.dirty ? '*' : ''}`)
	)
	return { ...io, buf, states }
}

test('a clean buffer is settled without touching the volume', async () => {
	const { buf, calls } = buffer()
	expect(await buf.settle()).toEqual({ settled: true })
	expect(calls).toEqual([])
})

test('an attached buffer saves where it belongs', async () => {
	const { buf, disk, calls } = buffer({ '/Kyoto.md': 'old' })
	expect(await buf.open('/Kyoto.md')).toEqual({ opened: true })
	buf.type('new body')
	expect(buf.snapshot()).toMatchObject({ dirty: true, path: '/Kyoto.md' })
	expect(await buf.settle()).toEqual({ settled: true })
	expect(disk['/Kyoto.md']).toBe('new body')
	expect(buf.snapshot().dirty).toBe(false)
	expect(calls).toEqual(['read /Kyoto.md', 'save /Kyoto.md'])
})

test('a scratch buffer becomes a note, and then belongs to it', async () => {
	const { buf, disk, calls } = buffer()
	buf.type('Kyoto\nFushimi Inari')
	expect(await buf.settle()).toEqual({ settled: true })
	expect(disk['/Kyoto.md']).toBe('Kyoto\nFushimi Inari')
	expect(buf.snapshot().path).toBe('/Kyoto.md')
	// The second settle UPDATES it — the note is not created twice.
	buf.type('Kyoto\nedited')
	expect(await buf.settle()).toEqual({ settled: true })
	expect(disk['/Kyoto.md']).toBe('Kyoto\nedited')
	expect(calls).toEqual(['create', 'save /Kyoto.md'])
})

test('a blank scratch buffer is never written', async () => {
	const { buf, calls, disk } = buffer()
	buf.type('   \n\t\n ')
	expect(await buf.settle()).toEqual({ settled: true })
	expect(calls).toEqual([])
	expect(Object.keys(disk)).toEqual([])
})

test('a save that fails leaves the buffer unsaved', async () => {
	const { buf, failNext } = buffer({ '/Kyoto.md': 'old' })
	await buf.open('/Kyoto.md')
	buf.type('words the user typed')
	failNext(new Error('EACCES: /notes/Kyoto.md'))
	const outcome = await buf.settle()
	expect(outcome).toMatchObject({ settled: false, because: 'failed', path: '/Kyoto.md' })
	// Unsaved, and STILL ATTACHED: the retry has to update the note, not duplicate it.
	expect(buf.snapshot()).toMatchObject({
		dirty: true,
		path: '/Kyoto.md',
		text: 'words the user typed'
	})
	expect(await buf.settle()).toEqual({ settled: true })
})

test('a retryable failure never becomes a duplicate note', async () => {
	const { buf, failNext, disk, calls } = buffer({ '/Kyoto.md': 'old' })
	await buf.open('/Kyoto.md')
	buf.type('edited')
	failNext(new Error('ENOSPC: no space left'))
	expect((await buf.settle()).settled).toBe(false)
	expect(await buf.settle()).toEqual({ settled: true })
	expect(Object.keys(disk).sort()).toEqual(['/Kyoto.md'])
	expect(disk['/Kyoto.md']).toBe('edited')
	expect(calls.filter((c) => c === 'create')).toEqual([])
})

test('a note that is GONE detaches the buffer, keeping the text', async () => {
	const { buf, failNext, disk } = buffer({ '/Trips/Kyoto.md': 'old' })
	await buf.open('/Trips/Kyoto.md')
	buf.type('Kyoto\nedited while it moved')
	failNext(new Error('ENOENT: /notes/Trips/Kyoto.md'))
	expect(await buf.settle()).toMatchObject({
		settled: false,
		because: 'gone',
		path: '/Trips/Kyoto.md'
	})
	// Detached but unsaved, so the next settle writes it as a NEW note — nothing is lost
	// and no folder is rebuilt around it.
	expect(buf.snapshot()).toMatchObject({ dirty: true, path: null })
	expect(await buf.settle()).toEqual({ settled: true })
	expect(disk['/Kyoto.md']).toBe('Kyoto\nedited while it moved')
	expect(buf.snapshot().path).toBe('/Kyoto.md')
})

test('a folder pretending to be a note is refused by the read, and nothing is opened', async () => {
	const { buf, failNext } = buffer({ '/Kyoto.md': 'body' })
	await buf.open('/Kyoto.md')
	failNext(new Error('EISDIR: /notes/Archive.md'))
	const outcome = await buf.open('/Archive.md')
	expect(outcome).toMatchObject({ opened: false, because: 'unreadable', path: '/Archive.md' })
	// Pointing at nothing, and not showing the previous note's body as if it were open.
	expect(buf.snapshot()).toEqual({ text: '', dirty: false, path: null })
})

test('words typed while an unreadable note was on its way become a note of their own', async () => {
	const { buf, freeze, disk } = buffer({ '/Kyoto.md': 'body' })
	const release = freeze()
	const opening = buf.open('/Gone.md') // there is no such note
	await inFlight()
	buf.type('Half a thought\nkeep me') // the user does not wait for reads
	release()
	// The note asked for cannot be opened, and the words typed meanwhile are not collateral
	// damage: they are written, because they were never anywhere else.
	expect(await opening).toMatchObject({ because: 'unreadable', gone: true })
	expect(disk['/Half a thought.md']).toBe('Half a thought\nkeep me')
})

test('nothing replaces a buffer that would not settle', async () => {
	const { buf, failNext, calls } = buffer({ '/Kyoto.md': 'old', '/Osaka.md': 'other' })
	await buf.open('/Kyoto.md')
	buf.type('unsaved words')
	failNext(new Error('EACCES: /notes/Kyoto.md'))
	const outcome = await buf.open('/Osaka.md')
	expect(outcome).toMatchObject({ opened: false, because: 'unsettled' })
	expect(buf.snapshot()).toMatchObject({ text: 'unsaved words', dirty: true, path: '/Kyoto.md' })
	expect(calls).not.toContain('read /Osaka.md')
	// The same is true of "New": it must not clear what could not be saved.
	failNext(new Error('EACCES: /notes/Kyoto.md'))
	expect((await buf.clear()).settled).toBe(false)
	expect(buf.snapshot().text).toBe('unsaved words')
})

test('keystrokes typed DURING a write are not reported as saved', async () => {
	const { buf, disk, freeze } = buffer({ '/Kyoto.md': 'old' })
	await buf.open('/Kyoto.md')
	buf.type('first')
	const release = freeze()
	const settling = buf.settle()
	buf.type('second') // …while the first write is in flight
	release()
	expect(await settling).toEqual({ settled: true })
	// Settled means settled: the newer text is on disk too, not left behind as "clean".
	expect(disk['/Kyoto.md']).toBe('second')
	expect(buf.snapshot().dirty).toBe(false)
})

test('a settle during a write does not report the other write’s optimism', async () => {
	// The bug this exists for: `dirty` is cleared on the way into a write, so a second
	// caller could read that flag, conclude "settled", and replace the buffer over words
	// whose write was still in flight — and about to fail.
	const { buf, failNext, freeze } = buffer({ '/Kyoto.md': 'old', '/Osaka.md': 'other' })
	await buf.open('/Kyoto.md')
	buf.type('precious words')
	const release = freeze()
	// An outage, not a hiccup: the retry inside the chain fails too, so the buffer is
	// still unsaved when the click gets its turn.
	failNext(new Error('EACCES: /notes/Kyoto.md'))
	failNext(new Error('EACCES: /notes/Kyoto.md'))
	const settling = buf.settle()
	const opening = buf.open('/Osaka.md') // a click while the save is in flight
	release()
	expect((await settling).settled).toBe(false)
	expect(await opening).toMatchObject({ opened: false, because: 'unsettled' })
	expect(buf.snapshot()).toMatchObject({ text: 'precious words', path: '/Kyoto.md' })
})

test('typing during a read keeps the keystrokes, saves them, and still opens the note', async () => {
	// The read was already on its way when the user typed. Those words belong to the note
	// they were typed into, so they are saved there — and the note that was asked for
	// still ends up open.
	const { buf, disk, calls, freeze } = buffer({ '/Kyoto.md': 'kyoto', '/Osaka.md': 'osaka' })
	await buf.open('/Kyoto.md')
	const release = freeze()
	const opening = buf.open('/Osaka.md')
	await inFlight()
	buf.type('kyoto, half a thought')
	release()
	expect(await opening).toEqual({ opened: true })
	expect(disk['/Kyoto.md']).toBe('kyoto, half a thought') // saved where it was typed
	expect(buf.snapshot()).toEqual({ text: 'osaka', dirty: false, path: '/Osaka.md' })
	expect(calls).toEqual(['read /Kyoto.md', 'read /Osaka.md', 'save /Kyoto.md', 'read /Osaka.md'])
})

test('a read that fails for a passing reason changes nothing', async () => {
	// EIO, EACCES, the volume briefly unreachable: the note is still there, so a buffer
	// that was holding it goes on holding it — detaching would send the next autosave
	// through `create` and leave a duplicate beside the note being edited.
	const { buf, failNext, disk } = buffer({ '/Kyoto.md': 'kyoto' })
	await buf.open('/Kyoto.md')
	buf.type('edited')
	expect(await buf.reload('/Kyoto.md')).toEqual({ opened: true }) // dirty: nothing to do
	expect(await buf.settle()).toEqual({ settled: true })
	expect(disk['/Kyoto.md']).toBe('edited')
	// An outright failed read of the open note keeps it attached.
	failNext(new Error('EACCES: /notes/Kyoto.md'))
	const reopened = await buf.open('/Kyoto.md')
	expect(reopened).toMatchObject({ opened: false, because: 'unreadable', gone: false })
	expect(buf.snapshot()).toMatchObject({ path: '/Kyoto.md', text: 'edited' })
})

test('a read that fails because the note is GONE lets go of it', async () => {
	const { buf, failNext } = buffer({ '/Kyoto.md': 'kyoto' })
	await buf.open('/Kyoto.md')
	failNext(new Error('ENOENT: /notes/Kyoto.md'))
	expect(await buf.open('/Kyoto.md')).toMatchObject({ gone: true })
	expect(buf.snapshot()).toEqual({ text: '', dirty: false, path: null })
})

test('a buffer can be put back when the operation that emptied it did not happen', async () => {
	// Deleting the open note discards its buffer before the delete is known to have
	// worked — a pending write would otherwise put the note straight back. If the delete
	// fails, the note is still there and so are the user's edits.
	const { buf, disk } = buffer({ '/Kyoto.md': 'kyoto' })
	await buf.open('/Kyoto.md')
	buf.type('unsaved edits')
	const before = buf.snapshot()
	const undiscard = buf.discard('/Kyoto.md')
	expect(buf.snapshot()).toEqual({ text: '', dirty: false, path: null })
	undiscard?.() // …the delete failed
	expect(buf.snapshot()).toEqual(before)
	expect(await buf.settle()).toEqual({ settled: true })
	expect(disk['/Kyoto.md']).toBe('unsaved edits')
})

test('the way back is only offered for the buffer the discard emptied', async () => {
	// Deleting some OTHER note must not touch the note being edited — and if that delete
	// fails, there is nothing to put back.
	const { buf } = buffer({ '/Kyoto.md': 'kyoto', '/Osaka.md': 'osaka' })
	await buf.open('/Kyoto.md')
	buf.type('being edited')
	expect(buf.discard('/Osaka.md')).toBe(null)
	expect(buf.snapshot()).toMatchObject({ text: 'being edited', path: '/Kyoto.md' })
})

test('the way back declines once the user has typed into the emptied buffer', async () => {
	// The snapshot is older than those keystrokes, and the newest words win.
	const { buf } = buffer({ '/Kyoto.md': 'kyoto' })
	await buf.open('/Kyoto.md')
	const undiscard = buf.discard('/Kyoto.md')
	buf.type('a fresh thought')
	undiscard?.() // …the delete failed, but the buffer has moved on
	expect(buf.snapshot()).toEqual({ text: 'a fresh thought', dirty: true, path: null })
})

test('a save that fails about an address the buffer has left is not a diagnosis', async () => {
	// An agent rename moves the open note while an autosave to its old address is in
	// flight. That save fails ENOENT about a path nobody is at any more; taking it for "the
	// note is gone" would detach the buffer from its NEW address and turn the unsaved words
	// into a duplicate. They belong to the note, wherever it now lives.
	const { buf, disk, calls, freeze } = buffer({ '/Kyoto.md': 'kyoto' })
	await buf.open('/Kyoto.md')
	buf.type('edited while it moved')
	const release = freeze()
	const settling = buf.settle()
	await inFlight()
	delete disk['/Kyoto.md'] // the rename happened first…
	disk['/Travel/Kyoto.md'] = 'kyoto'
	buf.moved('/Kyoto.md', '/Travel/Kyoto.md') // …and the GUI followed it
	release()
	expect(await settling).toEqual({ settled: true })
	expect(buf.snapshot()).toEqual({
		text: 'edited while it moved',
		dirty: false,
		path: '/Travel/Kyoto.md'
	})
	expect(disk['/Travel/Kyoto.md']).toBe('edited while it moved')
	expect(calls).toEqual(['read /Kyoto.md', 'save /Kyoto.md', 'save /Travel/Kyoto.md'])
})

test('a read that resolves after the buffer moved on is discarded', async () => {
	const { buf, disk, freeze } = buffer({ '/Kyoto.md': 'kyoto body', '/Osaka.md': 'osaka body' })
	const release = freeze()
	const opening = buf.open('/Kyoto.md')
	await inFlight()
	// The note is deleted while its body is on the way.
	buf.discard('/Kyoto.md')
	release()
	await opening
	expect(buf.snapshot().text).not.toBe('kyoto body')
	expect(disk['/Kyoto.md']).toBe('kyoto body') // and nothing was written on the way out
})

test('reload takes an external edit, but never over what the user is typing', async () => {
	const { buf, disk } = buffer({ '/Kyoto.md': 'first' })
	await buf.open('/Kyoto.md')
	disk['/Kyoto.md'] = 'edited by the agent'
	expect(await buf.reload('/Kyoto.md')).toEqual({ opened: true })
	expect(buf.snapshot().text).toBe('edited by the agent')
	// Now with unsaved edits in the buffer: the buffer is newer than the disk.
	buf.type('mine, unsaved')
	disk['/Kyoto.md'] = 'edited again by the agent'
	expect(await buf.reload('/Kyoto.md')).toEqual({ opened: true })
	expect(buf.snapshot().text).toBe('mine, unsaved')
	// A reload for a note we are not holding is nobody's business.
	await buf.reload('/Osaka.md')
	expect(buf.snapshot().path).toBe('/Kyoto.md')
})

test('a reload that cannot read REPORTS it, and changes nothing', async () => {
	// The caller has to be able to tell, because "we did not get a read" is not evidence that
	// nothing changed — app-notes' scratch stops being editable on this, so a stale buffer
	// cannot be autosaved over newer text another window wrote (DESIGN.md §6).
	const { buf, disk, failNext } = buffer({ '/Kyoto.md': 'first' })
	await buf.open('/Kyoto.md')
	disk['/Kyoto.md'] = 'newer, from somewhere else'
	failNext(new Error('EIO: disk'))
	const outcome = await buf.reload('/Kyoto.md')
	expect(outcome).toMatchObject({ opened: false, because: 'unreadable', gone: false })
	// Unchanged: still attached, still clean, still the text it had. A transient failure must
	// not detach (that would fork a duplicate) and must not empty the buffer either.
	expect(buf.snapshot()).toEqual({ text: 'first', dirty: false, path: '/Kyoto.md' })
})

test('a move carries the buffer with it, so the next save lands at the new path', async () => {
	const { buf, disk } = buffer({ '/Trips/Kyoto.md': 'body' })
	await buf.open('/Trips/Kyoto.md')
	buf.type('edited')
	disk['/Journeys/Kyoto.md'] = 'body' // the volume did the move…
	delete disk['/Trips/Kyoto.md']
	buf.moved('/Trips', '/Journeys') // …of the FOLDER, taking the note with it
	expect(buf.snapshot().path).toBe('/Journeys/Kyoto.md')
	expect(await buf.settle()).toEqual({ settled: true })
	expect(disk['/Journeys/Kyoto.md']).toBe('edited')
	expect(disk['/Trips/Kyoto.md']).toBeUndefined() // the old path was not rewritten
})

test('a deleted note is DISCARDED, not settled', async () => {
	const { buf, calls } = buffer({ '/Kyoto.md': 'body' })
	await buf.open('/Kyoto.md')
	buf.type('edits nobody wants')
	buf.discard('/Kyoto.md')
	expect(buf.snapshot()).toEqual({ text: '', dirty: false, path: null })
	expect(await buf.settle()).toEqual({ settled: true })
	// No write of any kind after the delete: a pending save would put the note back.
	expect(calls).toEqual(['read /Kyoto.md'])
})

test('deleting the folder the buffer lives in discards it, a sibling does not', async () => {
	const { buf } = buffer({ '/Trips/Kyoto.md': 'body', '/Trips 2/Osaka.md': 'other' })
	await buf.open('/Trips/Kyoto.md')
	buf.type('edits')
	buf.discard('/Trips 2') // a prefix of the string, but not a parent of the path
	expect(buf.snapshot()).toMatchObject({ dirty: true, path: '/Trips/Kyoto.md' })
	buf.discard('/Trips')
	expect(buf.snapshot()).toEqual({ text: '', dirty: false, path: null })
})

test('a scratch note that cannot be created anywhere stays unsaved', async () => {
	const { buf, failNext } = buffer()
	buf.type('Doomed note\nsome words')
	failNext(new Error('the volume is unreachable'))
	expect(await buf.settle()).toMatchObject({ settled: false, because: 'failed', path: null })
	expect(buf.snapshot()).toMatchObject({ dirty: true, text: 'Doomed note\nsome words' })
	// And the next transition retries it rather than dropping it.
	expect(await buf.clear()).toEqual({ settled: true })
	expect(buf.snapshot()).toEqual({ text: '', dirty: false, path: null })
})
