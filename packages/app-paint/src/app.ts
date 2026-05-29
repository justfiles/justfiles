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
	actions: (b) => ({
		setTool: b.handler({
			description: 'Pick the active drawing tool.',
			schema: v.object({ tool }),
			handler({ tool }, ctx) {
				return { ...ctx.state, tool }
			}
		}),
		setSize: b.handler({
			description: 'Pick the active brush size.',
			schema: v.object({ size }),
			handler({ size }, ctx) {
				return { ...ctx.state, size }
			}
		}),
		setColor: b.handler({
			description: 'Pick the active color (hex #rrggbb).',
			schema: v.object({ color }),
			handler({ color }, ctx) {
				return { ...ctx.state, color }
			}
		}),
		ensureDoc: b.handler({
			description: 'Return the current draft id, minting + persisting one on first run.',
			schema: v.object({ candidate: v.string() }),
			handler({ candidate }, ctx) {
				return ctx.state.currentDocId ? ctx.state : { ...ctx.state, currentDocId: candidate }
			}
		}),
		loadDraft: b.query({
			description: 'Read the autosaved draft document, or null if none exists.',
			schema: v.object({ docId: v.string() }),
			async handler({ docId }, ctx): Promise<PaintDoc | null> {
				const path = draftPath(docId)
				if (!(await ctx.capabilities.volume.exists({ path }))) return null
				return decode(await ctx.capabilities.volume.readFile({ path }))
			}
		}),
		saveDraft: b.query({
			description: 'Autosave the working draft document to the app data volume.',
			schema: v.object({ docId: v.string(), doc: docSchema }),
			async handler({ docId, doc }, ctx): Promise<boolean> {
				await ctx.capabilities.volume.writeFile({
					path: draftPath(docId),
					data: encode(doc as PaintDoc)
				})
				return true
			}
		}),
		save: b.handler({
			description: 'Save the current canvas as PNG to /Paint/.',
			schema: v.object({
				pngBase64: v.pipe(v.string(), v.minLength(1)),
				filename: v.optional(v.string())
			}),
			async handler({ pngBase64, filename }, ctx) {
				try {
					const safe = filename?.replace(/[^\w.-]/g, '_')
					const name = safe || `untitled-${timestamp()}.png`
					const path = `${SAVE_DIR}/${name}`
					await ctx.capabilities.volume.writeFile({ path, data: base64ToBytes(pngBase64) })
					return { ...ctx.state, lastSavedPath: path, lastError: null }
				} catch (err) {
					return {
						...ctx.state,
						lastError: err instanceof Error ? err.message : String(err)
					}
				}
			}
		}),
		clearStatus: b.handler({
			description: 'Clear the save/error status line.',
			schema: v.object({}),
			handler(_, ctx) {
				return { ...ctx.state, lastSavedPath: null, lastError: null }
			}
		})
	})
})

export type PaintApp = typeof app
