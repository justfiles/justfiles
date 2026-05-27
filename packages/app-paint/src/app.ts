import { defineApp } from '@justfiles/app'
import { volume } from '@justfiles/app/capabilities/volume'
import * as v from 'valibot'

export type Tool = 'pencil' | 'eraser' | 'fill' | 'line' | 'rect' | 'ellipse'
export type Size = 1 | 3 | 5

export type PaintState = {
	tool: Tool
	size: Size
	color: string
	lastSavedPath: string | null
	lastError: string | null
}

export const initialState: PaintState = {
	tool: 'pencil',
	size: 1,
	color: '#000000',
	lastSavedPath: null,
	lastError: null
}

const SAVE_DIR = '/Paint'

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
