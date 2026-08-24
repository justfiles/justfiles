import { defineApp } from '@justfiles/app'
import { volume } from '@justfiles/app/capabilities/volume'
import * as v from 'valibot'

// State is intentionally minimal — only durable facts worth carrying across a
// reload: what the user is looking at, a cache-busting revision for the open
// file, the last-known file list, and the last scan error. The bytes at a path
// can change underneath us, so they belong to a query that re-reads on demand
// (think `cat /path/to/file`), never to state.
//
// There is deliberately NO "a scan is running" flag here. Whether a scan is in
// flight is runtime truth owned by the kernel's command runtime, not a durable
// app fact — a persisted "loading" would be a lie after any restart (the command
// is in memory only). The scan is emitted `.coalesce()`d, so the runtime
// single-flights it and folds a trailing re-scan when a change lands mid-scan;
// the reducer just asks for a scan and folds whatever files come back.
export type FilesState = {
	currentViewing: string | null
	// Bumped each time the watched file changes on disk (Part D). The GUI keys its
	// preview re-read on it, so an external edit refreshes the open file.
	revision: number
	files: Array<{ path: string }>
	// Finder-style "show all files" toggle. Off by default: the GUI shows only the
	// user-facing top-level folders (USER_FACING_ROOTS). On: the whole volume,
	// including the runtime prefixes (⌘⇧. in the GUI, like macOS Finder). This is a
	// persisted view MODE — the agent still sees the full `files` list either way;
	// the whitelist is a presentation filter applied in the GUI, not in state.
	showHidden: boolean
	// Last scan failure, shown until the next scan clears it.
	error: string | null
}

export const initialState: FilesState = {
	currentViewing: null,
	revision: 0,
	files: [],
	showHidden: false,
	error: null
}

// The Finder-like whitelist: only these top-level folders are shown by default.
// This is deliberately small and grows by hand as more user-facing locations
// earn a place in the sidebar. Everything else (the per-app /data chroots,
// /system, /state, …) is "hidden" until ⌘⇧. reveals it.
const USER_FACING_ROOTS = ['/notes', '/pictures', '/stickies'] as const

// A path is user-facing when it sits under one of the whitelisted roots. The
// match is case-INsensitive: the constant is lowercase, but generated images
// currently land under `/Pictures` (capital P) on `main` — a lowercasing of that
// dir rides a separate branch — and a case-sensitive check would hide every
// generated image from the default view until that branch merges. Folding case
// keeps the default view correct whichever casing wins.
export function isUserFacing(path: string): boolean {
	const lower = path.toLowerCase()
	return USER_FACING_ROOTS.some((root) => lower === root || lower.startsWith(`${root}/`))
}

// Cap what the readFile query returns. 256 KiB is enough for inspecting
// source/text files. Images get a larger budget since base64 inflates the
// payload ~33% and a real photo dwarfs a text file.
const PREVIEW_LIMIT = 256 * 1024
const IMAGE_LIMIT = 8 * 1024 * 1024
const decoder = new TextDecoder()

// Extension → MIME for the image types a browser <img> renders. A file whose
// extension is here is previewed as an image (data URL), not decoded as text.
const IMAGE_MIME: Record<string, string> = {
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	gif: 'image/gif',
	webp: 'image/webp',
	bmp: 'image/bmp',
	svg: 'image/svg+xml',
	ico: 'image/x-icon',
	avif: 'image/avif'
}

function imageMime(path: string): string | null {
	const dot = path.lastIndexOf('.')
	return dot === -1 ? null : (IMAGE_MIME[path.slice(dot + 1).toLowerCase()] ?? null)
}

// Bytes → base64, chunked so the argument spread never overflows the call stack
// on a large image. `btoa` is a Worker global (the sandbox runs there).
function toBase64(bytes: Uint8Array): string {
	let binary = ''
	const chunk = 0x8000
	for (let i = 0; i < bytes.length; i += chunk)
		binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
	return btoa(binary)
}

const pathSchema = v.pipe(
	v.string(),
	v.minLength(1),
	v.regex(/^\//, 'path must be absolute'),
	v.check((path) => !path.split('/').includes('..'), 'path may not contain ..')
)

export const app = defineApp({
	init: initialState,
	capabilities: { volume: volume({ scopes: ['system'] }) },
	// Two watches, both pure functions of state (Part D). The recursive one is
	// always live: it reports structural changes anywhere in the volume so the tree
	// auto-refreshes (folds via `treeChanged`). The single-path one tracks the open
	// file's bytes for the preview, kept alive only while `currentViewing` holds.
	// The recursive watch is `.coalesce()`d: it is a wake ("the tree moved, re-scan"),
	// so an unreduced event is fully superseded by a newer one — a bulk delete/import
	// folds into one reduce plus a trailing one instead of queueing a dispatch per
	// entry, which is what used to starve this app's queue (and its GUI boot).
	subscriptions: (state, sub) => [
		sub.capability('volume', 'watch', { path: '/', recursive: true }).coalesce().to('treeChanged'),
		...(state.currentViewing
			? [sub.capability('volume', 'watch', { path: state.currentViewing }).to('fileChanged')]
			: [])
	],
	// Every state transition is a pure edge. The one effect — scanning the
	// volume — is emitted as command data; its result folds back via `filesLoaded`.
	// The scan is `.coalesce()`d, so the kernel single-flights it and folds a
	// trailing re-scan when a change lands mid-scan (see kernel.command.ts).
	update: (t) => {
		const scan = () =>
			t.cmd('volume', 'scan', { path: '/', recursive: true }).coalesce().to('filesLoaded')
		return {
			refresh: t.on(v.object({}), (state) => [{ ...state, error: null }, scan()], {
				description: 'Refresh the visible file list.'
			}),
			// The recursive watch fired: a structural change reshaped the tree, so
			// re-scan. Coalescing in the runtime collapses a burst (e.g. a git
			// checkout) into one scan plus at most one trailing pass — no flag here.
			treeChanged: t.fromEvent('volume', 'watch', (state) => [state, scan()]),
			filesLoaded: t.fromResult('volume', 'scan', (state, r) => {
				if (!r.ok) return { ...state, error: r.error.message }
				const files = r.value
					.filter((entry) => entry.type === 'file')
					.map((entry) => ({ path: entry.path }))
					.sort((a, b) => a.path.localeCompare(b.path))
				const stillThere = files.some((file) => file.path === state.currentViewing)
				return {
					...state,
					files,
					currentViewing: stillThere ? state.currentViewing : null,
					error: null
				}
			}),
			setView: t.on(
				v.object({ path: pathSchema }),
				(state, { path }) => ({ ...state, currentViewing: path, error: null }),
				{ description: 'Record which file the user is currently viewing.' }
			),
			clear: t.on(v.object({}), (state) => ({ ...state, currentViewing: null, error: null }), {
				description: 'Clear the current Files selection.'
			}),
			// Flip the Finder-style "show all files" mode. Off (default) shows only the
			// user-facing folders (USER_FACING_ROOTS); on shows the whole volume. The
			// GUI binds this to ⌘⇧. (macOS's "show hidden files"). No re-scan: `files`
			// already holds everything, so the GUI just re-derives what it renders.
			toggleHidden: t.on(v.object({}), (state) => ({ ...state, showHidden: !state.showHidden }), {
				description:
					'Toggle showing every file vs only the user-facing folders (/notes, /pictures, /stickies).'
			}),
			// The watched file changed on disk — bump `revision` so the GUI re-reads it.
			// The bytes themselves never enter state (the preview is a caller-scoped
			// query); this is just the change signal.
			fileChanged: t.fromEvent('volume', 'watch', (state) => ({
				...state,
				revision: state.revision + 1
			}))
		}
	},
	// A caller-scoped read (Part C): the bytes return to the caller, never into
	// state. The kernel attaches the declared scopes to `app.invoke`.
	procedures: (p) => ({
		readFile: p.procedure({
			description:
				'Read a file: images return a data URL, everything else text (capped at the preview limit).',
			schema: v.object({ path: pathSchema }),
			async run({ path }, app) {
				const bytes = await app.invoke('volume', 'readFile', path)
				const mime = imageMime(path)
				if (mime) {
					// Too large to inline: report the size but skip the data URL so the
					// GUI shows a "too large" note instead of a multi-MB base64 payload.
					const truncated = bytes.byteLength > IMAGE_LIMIT
					return {
						path,
						kind: 'image' as const,
						dataUrl: truncated ? null : `data:${mime};base64,${toBase64(bytes)}`,
						truncated,
						size: bytes.byteLength
					}
				}
				const truncated = bytes.byteLength > PREVIEW_LIMIT
				const slice = truncated ? bytes.subarray(0, PREVIEW_LIMIT) : bytes
				// `size` is the full byte length on disk, not the (possibly capped)
				// preview slice — so the status bar reports the real file size.
				return {
					path,
					kind: 'text' as const,
					content: decoder.decode(slice),
					truncated,
					size: bytes.byteLength
				}
			}
		}),

		// Destructive — gui-only (the right-click "Delete" in the tree). The agent
		// never removes user files blindly. `recursive` clears a folder and all its
		// contents; `force` makes a missing path a no-op. The removal fires the
		// recursive watch, which folds a re-scan via `treeChanged` — so the tree
		// refreshes itself and `filesLoaded` clears `currentViewing` if it's gone.
		remove: p.procedure({
			description: 'Delete a file or folder.',
			audience: 'gui',
			schema: v.object({ path: pathSchema }),
			async run({ path }, app) {
				await app.invoke('volume', 'rm', path, { recursive: true, force: true })
			}
		})
	})
})

export type FilesApp = typeof app
