import { defineApp } from '@justfiles/app'
import { volume } from '@justfiles/app/capabilities/volume'
import * as v from 'valibot'

export type FilesState = {
	currentViewing: string | null
	revision: number
	treeRevision: number
	showHidden: boolean
}

export type DirectoryResult =
	| { path: string; entries: Array<{ ino: string; name: string; type: number }> }
	| { path: string; error: string }

export const initialState: FilesState = {
	currentViewing: null,
	revision: 0,
	treeRevision: 0,
	showHidden: false
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

// A write also drops the old persisted file-list cache.
function normalizeState(state: FilesState): FilesState {
	return {
		currentViewing: state.currentViewing ?? null,
		revision: state.revision ?? 0,
		treeRevision: state.treeRevision ?? 0,
		showHidden: state.showHidden ?? false
	}
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
	subscriptions: (state, sub) => [
		sub.capability('volume', 'watch', { path: '/', recursive: true }).coalesce().to('treeChanged'),
		...(state.currentViewing
			? [sub.capability('volume', 'watch', { path: state.currentViewing }).to('fileChanged')]
			: [])
	],
	update: (t) => ({
		treeChanged: t.fromEvent('volume', 'watch', (state) => {
			const next = normalizeState(state)
			return { ...next, treeRevision: next.treeRevision + 1 }
		}),
		setView: t.on(
			v.object({ path: pathSchema }),
			(state, { path }) => ({ ...normalizeState(state), currentViewing: path }),
			{ description: 'Record which file the user is currently viewing.' }
		),
		clear: t.on(v.object({}), (state) => ({ ...normalizeState(state), currentViewing: null }), {
			description: 'Clear the current Files selection.'
		}),
		toggleHidden: t.on(
			v.object({}),
			(state) => {
				const next = normalizeState(state)
				return { ...next, showHidden: !next.showHidden }
			},
			{
				description:
					'Toggle showing every file vs only the user-facing folders (/notes, /pictures, /stickies).'
			}
		),
		fileChanged: t.fromEvent('volume', 'watch', (state) => {
			const next = normalizeState(state)
			return { ...next, revision: next.revision + 1 }
		})
	}),
	// A caller-scoped read (Part C): the bytes return to the caller, never into
	// state. The kernel attaches the declared scopes to `app.invoke`.
	procedures: (p) => ({
		listDirectories: p.procedure({
			description: 'List the direct children of one or more folders.',
			audience: 'gui',
			schema: v.object({ paths: v.pipe(v.array(pathSchema), v.minLength(1)) }),
			async run({ paths }, app): Promise<DirectoryResult[]> {
				return Promise.all(
					[...new Set(paths)].map(async (path) => {
						try {
							return { path, entries: await app.invoke('volume', 'readdir', path) }
						} catch (error) {
							return {
								path,
								error: error instanceof Error ? error.message : String(error)
							}
						}
					})
				)
			}
		}),
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
