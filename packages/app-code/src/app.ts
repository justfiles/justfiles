import { defineApp } from '@justfiles/app'
import { devkit } from '@justfiles/app/capabilities/devkit'
import { type VolumeCapability, volume } from '@justfiles/app/capabilities/volume'
import * as v from 'valibot'

export type CodePane = 'editor' | 'preview'

export type CodeState = {
	slug: string
	files: string[]
	selectedPath: string | null
	dirty: boolean
	rightPane: CodePane
	previewId: string | null
	diagnostics: string[]
}

export const initialState: CodeState = {
	slug: 'untitled',
	files: [],
	selectedPath: null,
	dirty: false,
	rightPane: 'editor',
	previewId: null,
	diagnostics: []
}

export function isCodeState(value: unknown): value is CodeState {
	return (
		!!value &&
		typeof value === 'object' &&
		'slug' in value &&
		'files' in value &&
		'rightPane' in value
	)
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const SRC = (slug: string, path = '') => `/projects/${slug}/src${path}`

const slugSchema = v.pipe(
	v.string(),
	v.minLength(1),
	v.regex(
		/^[a-z0-9._-]+$/i,
		'slug may only contain letters, numbers, dots, underscores, and dashes'
	),
	v.check((slug) => slug !== '.' && slug !== '..', 'slug may not be . or ..')
)
const srcPathSchema = v.pipe(
	v.string(),
	v.minLength(1),
	v.check(
		(path) => !path.startsWith('/') && !path.split('/').includes('..'),
		'path must be relative to src and may not contain ..'
	)
)

export const app = defineApp({
	init: initialState,
	capabilities: { volume: volume({ scopes: [] }), devkit: devkit({ scopes: [] }) },
	actions: (b) => ({
		open: b.handler({
			description: 'Open a project from app-code storage, seeding it on first use.',
			schema: v.object({ slug: slugSchema }),
			examples: [{ params: { slug: 'untitled' } }],
			async handler({ slug }, ctx) {
				const state = normalizeState(ctx.state)
				if (!(await ctx.capabilities.volume.exists({ path: SRC(slug) }))) {
					await seed(ctx.capabilities.volume, slug)
				}
				const files = await listFiles(ctx.capabilities.volume, slug)
				const selectedPath = files.includes(state.selectedPath ?? '')
					? state.selectedPath
					: (files[0] ?? null)
				return { ...state, slug, files, selectedPath, dirty: false }
			}
		}),
		select: b.handler({
			description: 'Open a source file for editing.',
			schema: v.object({ path: srcPathSchema }),
			examples: [{ params: { path: 'app.ts' } }],
			handler({ path }, ctx) {
				const state = normalizeState(ctx.state)
				if (!state.files.includes(path) || path === state.selectedPath) return state
				return { ...state, selectedPath: path, dirty: false }
			}
		}),
		edit: b.handler({
			description: 'Mark the open file as having unsaved edits.',
			schema: v.object({}),
			handler(_, ctx) {
				const state = normalizeState(ctx.state)
				if (!state.selectedPath || state.dirty) return state
				return { ...state, dirty: true }
			}
		}),
		// A real state transition: persist the bytes and clear `dirty` for the open
		// file. Both the GUI and an agent drive this the same way — the reducer is
		// the single source of truth for "is the open file saved?".
		write: b.handler({
			description: 'Persist a source file and mark it saved.',
			schema: v.object({ path: srcPathSchema, content: v.string() }),
			examples: [{ params: { path: 'app.ts', content: '' } }],
			async handler({ path, content }, ctx) {
				const state = normalizeState(ctx.state)
				await ctx.capabilities.volume.writeFile({
					path: SRC(state.slug, `/${path}`),
					data: encoder.encode(content)
				})
				return path === state.selectedPath ? { ...state, dirty: false } : state
			}
		}),
		setPane: b.handler({
			description: 'Switch the right pane between the editor and the live preview.',
			schema: v.object({ pane: v.picklist(['editor', 'preview']) }),
			examples: [{ params: { pane: 'preview' } }],
			handler({ pane }, ctx) {
				const state = normalizeState(ctx.state)
				return state.rightPane === pane ? state : { ...state, rightPane: pane }
			}
		}),
		// Compile the project and (re)mount it in the preview pane. `reset` wipes
		// the draft's persisted state for a clean boot (⟳ Run/Restart); a plain
		// run keeps state across rebuilds, for the live hot-reload feel on save.
		run: b.handler({
			description: 'Compile the project and run it in the preview pane.',
			schema: v.object({ reset: v.optional(v.boolean()) }),
			examples: [{ params: {} }, { params: { reset: true } }],
			async handler({ reset }, ctx) {
				const state = normalizeState(ctx.state)
				const files = await readSource(ctx.capabilities.volume, state.slug)
				const { previewId, diagnostics } = await ctx.capabilities.devkit.run({
					slug: state.slug,
					files,
					reset
				})
				return { ...state, previewId, diagnostics }
			}
		}),
		stop: b.handler({
			description: 'Tear down the running preview.',
			schema: v.object({}),
			async handler(_, ctx) {
				const state = normalizeState(ctx.state)
				if (state.previewId) await ctx.capabilities.devkit.stop({ previewId: state.previewId })
				return { ...state, previewId: null, diagnostics: [] }
			}
		}),
		readFile: b.query({
			description: 'Read a source file as text.',
			schema: v.object({ path: srcPathSchema }),
			async handler({ path }, ctx) {
				const state = normalizeState(ctx.state)
				return decoder.decode(
					await ctx.capabilities.volume.readFile({ path: SRC(state.slug, `/${path}`) })
				)
			}
		})
	})
})

function normalizeState(state: CodeState): CodeState {
	return isCodeState(state) ? state : initialState
}

async function listFiles(volume: VolumeCapability, slug: string): Promise<string[]> {
	const root = SRC(slug)
	const entries = await volume.scan({ path: root, recursive: true })
	return entries
		.filter((entry) => entry.type === 'file')
		.map((entry) => entry.path.slice(root.length + 1))
		.sort((a, b) => a.localeCompare(b))
}

// Read every source file fresh from disk as a path→content map for the
// compiler. Reads from the volume (not `state.files`) so a just-saved edit is
// always included, regardless of pending state pushes.
async function readSource(volume: VolumeCapability, slug: string): Promise<Record<string, string>> {
	const files = await listFiles(volume, slug)
	const entries = await Promise.all(
		files.map(
			async (path) =>
				[path, decoder.decode(await volume.readFile({ path: SRC(slug, `/${path}`) }))] as const
		)
	)
	return Object.fromEntries(entries)
}

async function seed(volume: VolumeCapability, slug: string): Promise<void> {
	await volume.writeFile({ path: SRC(slug, '/app.ts'), data: encoder.encode(starterApp) })
	await volume.writeFile({ path: SRC(slug, '/gui.ts'), data: encoder.encode(starterGui) })
}

const starterApp = `import { defineApp } from '@justfiles/app'
import * as v from 'valibot'

export type CounterState = {
	count: number
}

export const app = defineApp({
	init: { count: 0 } as CounterState,
	actions: (b) => ({
		increment: b.handler({
			schema: v.object({}),
			handler(_, ctx) {
				return { count: ctx.state.count + 1 }
			}
		})
	})
})

export type CounterApp = typeof app
`

const starterGui = `import { defineGUI } from '@justfiles/app/browser'
import type { CounterApp, CounterState } from './app'

const stateOrInitial = (state: CounterState | null): CounterState => state ?? { count: 0 }

export const gui = defineGUI<CounterApp>({
	mount(el, state, ctx) {
		const render = (next: CounterState | null) => {
			const current = stateOrInitial(next)
			const button = document.createElement('button')
			button.type = 'button'
			button.textContent = \`Count: \${current.count}\`
			button.onclick = () => void ctx.client.increment({})
			Object.assign(button.style, {
				border: '0',
				borderRadius: '8px',
				background: '#2563eb',
				color: '#fff',
				font: '16px system-ui, sans-serif',
				padding: '10px 14px'
			})
			el.replaceChildren(button)
		}
		render(state)
		return { update: render, unmount: () => el.replaceChildren() }
	}
})
`

export type CodeApp = typeof app
