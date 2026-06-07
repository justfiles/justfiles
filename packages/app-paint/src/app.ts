import { defineApp } from '@justfiles/app'
import { volume } from '@justfiles/app/capabilities/volume'
import * as v from 'valibot'
import { decode, encode, type PaintDoc, type Size } from './doc.ts'

export type Tool = 'pencil' | 'eraser' | 'fill' | 'line' | 'rect' | 'ellipse'
export type { Size }

export type PaintState = {
	tool: Tool
	size: Size
	color: string
	currentDocId: string | null
	lastSavedPath: string | null
	lastError: string | null
}

export const initialState: PaintState = {
	tool: 'pencil',
	size: 1,
	color: '#000000',
	currentDocId: null,
	lastSavedPath: null,
	lastError: null
}

const SAVE_DIR = '/Paint'
const DRAFTS_DIR = '/drafts'

const draftPath = (docId: string) => `${DRAFTS_DIR}/${docId.replace(/[^\w-]/g, '_')}.json`

// Envelope-only validation; ops keep their per-op `id`/`kind` but stay loose
// (the doc shape is owned by our own GUI). encode/decode handle the bytes.
const docSchema = v.object({
	type: v.literal('justfiles/paint'),
	version: v.literal(1),
	width: v.number(),
	height: v.number(),
	background: v.string(),
	ops: v.array(v.looseObject({ id: v.string(), kind: v.string() }))
})

function timestamp(): string {
	return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
}

function base64ToBytes(b64: string): Uint8Array {
	const bin = atob(b64)
	const out = new Uint8Array(bin.length)
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
	return out
}

const tool = v.picklist(['pencil', 'eraser', 'fill', 'line', 'rect', 'ellipse'] as const)
const size = v.picklist([1, 3, 5] as const)
const color = v.pipe(v.string(), v.regex(/^#[0-9a-fA-F]{6}$/))

export const app = defineApp({
	init: initialState,
	capabilities: { volume: volume({ scopes: [] }) },
	update: (t) => ({
		setTool: t.on(v.object({ tool }), (state, { tool }) => ({ ...state, tool }), {
			description: 'Pick the active drawing tool.'
		}),
		setSize: t.on(v.object({ size }), (state, { size }) => ({ ...state, size }), {
			description: 'Pick the active brush size.'
		}),
		setColor: t.on(v.object({ color }), (state, { color }) => ({ ...state, color }), {
			description: 'Pick the active color (hex #rrggbb).'
		}),
		ensureDoc: t.on(
			v.object({ candidate: v.string() }),
			(state, { candidate }) =>
				state.currentDocId ? state : { ...state, currentDocId: candidate },
			{ description: 'Return the current draft id, minting + persisting one on first run.' }
		),
		// The save effect: stamp the path optimistically, write the bytes as a
		// command, and clear it again if the write fails.
		save: t.on(
			v.object({
				pngBase64: v.pipe(v.string(), v.minLength(1)),
				filename: v.optional(v.string())
			}),
			(state, { pngBase64, filename }) => {
				const safe = filename?.replace(/[^\w.-]/g, '_')
				const name = safe || `untitled-${timestamp()}.png`
				const path = `${SAVE_DIR}/${name}`
				return [
					{ ...state, lastSavedPath: path, lastError: null },
					t.cmd('volume', 'writeFile', path, base64ToBytes(pngBase64)).to('saved')
				]
			},
			{ description: 'Save the current canvas as PNG to /Paint/.' }
		),
		saved: t.fromResult('volume', 'writeFile', (state, r) =>
			r.ok ? state : { ...state, lastSavedPath: null, lastError: r.error.message }
		),
		clearStatus: t.on(
			v.object({}),
			(state) => ({ ...state, lastSavedPath: null, lastError: null }),
			{ description: 'Clear the save/error status line.' }
		)
	}),
	// Draft read/write return a value (or are caller-scoped autosaves), so they
	// live in procedures rather than the pure core.
	procedures: (p) => ({
		loadDraft: p.procedure({
			description: 'Read the autosaved draft document, or null if none exists.',
			schema: v.object({ docId: v.string() }),
			async run({ docId }, app): Promise<PaintDoc | null> {
				const path = draftPath(docId)
				if (!(await app.invoke('volume', 'exists', path))) return null
				return decode(await app.invoke('volume', 'readFile', path))
			}
		}),
		saveDraft: p.procedure({
			description: 'Autosave the working draft document to the app data volume.',
			schema: v.object({ docId: v.string(), doc: docSchema }),
			async run({ docId, doc }, app): Promise<boolean> {
				await app.invoke('volume', 'writeFile', draftPath(docId), encode(doc as PaintDoc))
				return true
			}
		})
	})
})

export type PaintApp = typeof app
