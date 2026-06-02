import { defineApp } from '@justfiles/app'
import { devkit } from '@justfiles/app/capabilities/devkit'
import { type VolumeCapability, volume } from '@justfiles/app/capabilities/volume'
import * as v from 'valibot'

export type CodeView = 'source' | 'app'

// The last build, tagged with the hash of the source it compiled. `result`
// covers a runtime crash too (Phase 5) — a crash is still a fact about the
// version that was built.
export type CodeBuild = {
	hash: string
	result: 'ok' | 'failed' | 'crashed'
	diagnostics: string[]
	message: string
	at: number
}

export type CodeState = {
	// persisted document — open project, selected file, view
	slug: string
	selectedPath: string | null
	view: CodeView
	// content identity + last build; both are honest functions of the files on disk
	files: string[] // cache of the disk scan, refreshed by open
	sourceHash: string // hash of the current source on disk
	build: CodeBuild | null
}

export const initialState: CodeState = {
	slug: 'untitled',
	selectedPath: null,
	view: 'app',
	files: [],
	sourceHash: '',
	build: null
}

// Derived toolbar label — never stored. Computed from the build record, the
// hash comparison, and whether a `run` is in flight (client-local).
export type CodeStatus = 'idle' | 'updating' | 'building' | 'live' | 'needs-fixes' | 'crashed'

export function statusOf(state: CodeState, running: boolean): CodeStatus {
	if (running) return 'building'
	if (!state.build) return 'idle'
	if (state.build.hash !== state.sourceHash) return 'updating'
	if (state.build.result === 'failed') return 'needs-fixes'
	if (state.build.result === 'crashed') return 'crashed'
	return 'live'
}

export function isCodeState(value: unknown): value is CodeState {
	return (
		!!value && typeof value === 'object' && 'slug' in value && 'files' in value && 'view' in value
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
				const source = await readSource(ctx.capabilities.volume, slug)
				const files = Object.keys(source)
				const selectedPath = files.includes(state.selectedPath ?? '')
					? state.selectedPath
					: (files[0] ?? null)
				// Run the initial build so the App is live on open, resuming the
				// draft's persisted runtime state (no reset).
				const hash = hashSource(source)
				const { diagnostics } = await ctx.capabilities.devkit.run({ slug, files: source })
				return {
					...state,
					slug,
					files,
					selectedPath,
					sourceHash: hash,
					build: buildRecord(hash, diagnostics)
				}
			}
		}),
		select: b.handler({
			description: 'Open a source file for editing.',
			schema: v.object({ path: srcPathSchema }),
			examples: [{ params: { path: 'app.ts' } }],
			handler({ path }, ctx) {
				const state = normalizeState(ctx.state)
				if (!state.files.includes(path) || path === state.selectedPath) return state
				return { ...state, selectedPath: path }
			}
		}),
		// Persist the bytes and recompute `sourceHash`. Fast; no compile; does not
		// touch `build`. Clients write as many files as they need, then `run` once.
		// Re-reading the small source set to rehash is cheap.
		write: b.handler({
			description: 'Persist a source file and recompute the source hash.',
			schema: v.object({ path: srcPathSchema, content: v.string() }),
			examples: [{ params: { path: 'app.ts', content: '' } }],
			async handler({ path, content }, ctx) {
				const state = normalizeState(ctx.state)
				await ctx.capabilities.volume.writeFile({
					path: SRC(state.slug, `/${path}`),
					data: encoder.encode(content)
				})
				return {
					...state,
					sourceHash: hashSource(await readSource(ctx.capabilities.volume, state.slug))
				}
			}
		}),
		setView: b.handler({
			description: 'Switch between the Source and App views. Never builds.',
			schema: v.object({ view: v.picklist(['source', 'app']) }),
			examples: [{ params: { view: 'app' } }],
			handler({ view }, ctx) {
				const state = normalizeState(ctx.state)
				return state.view === view ? state : { ...state, view }
			}
		}),
		// Read the freshest source from disk, hash it, compile + mount via
		// `devkit.run`, and record the outcome tagged with the hash it built. Leaves
		// `sourceHash` alone (write owns it), so a write that lands mid-run shows up
		// as `updating` afterward. On compile failure the last-good App stays
		// mounted and the record carries the diagnostics. `reset` wipes the draft's
		// persisted state for a clean boot (restart).
		run: b.handler({
			description: 'Compile the current source and run it as the live App.',
			schema: v.object({ reset: v.optional(v.boolean()) }),
			examples: [{ params: {} }, { params: { reset: true } }],
			async handler({ reset }, ctx) {
				const state = normalizeState(ctx.state)
				const source = await readSource(ctx.capabilities.volume, state.slug)
				const hash = hashSource(source)
				const { diagnostics } = await ctx.capabilities.devkit.run({
					slug: state.slug,
					files: source,
					reset
				})
				// sourceHash untouched — write owns it
				return { ...state, build: buildRecord(hash, diagnostics) }
			}
		}),
		// Internal cleanup only (unmount), not a user gesture; `previewId` is a pure
		// function of the slug, derived here rather than stored.
		stop: b.handler({
			description: 'Tear down the running App.',
			schema: v.object({}),
			async handler(_, ctx) {
				const state = normalizeState(ctx.state)
				await ctx.capabilities.devkit.stop({ previewId: `preview.${state.slug}` })
				return state
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

// Coerce ctx.state into the current shape on every handler. New-shape state
// passes through untouched (so a `run`'s build survives later handlers). Old
// persisted state is migrated: `rightPane` → `view`, everything runtime reset
// (`build` null, `sourceHash` '') — `open` recomputes the hash.
function normalizeState(state: unknown): CodeState {
	if (isCodeState(state)) return state
	if (!state || typeof state !== 'object') return initialState
	const old = state as { slug?: unknown; selectedPath?: unknown; rightPane?: unknown }
	return {
		...initialState,
		slug: typeof old.slug === 'string' ? old.slug : initialState.slug,
		selectedPath: typeof old.selectedPath === 'string' ? old.selectedPath : null,
		view:
			old.rightPane === 'preview'
				? 'app'
				: old.rightPane === 'editor'
					? 'source'
					: initialState.view
	}
}

// Stable content identity for a source set: FNV-1a over the sorted path→content
// map. Non-cryptographic — it only needs to detect change and tag a build.
function hashSource(files: Record<string, string>): string {
	const text = Object.keys(files)
		.sort()
		.map((path) => `${path}\0${files[path]}`)
		.join('\0')
	let hash = 2166136261
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i)
		hash = Math.imul(hash, 16777619)
	}
	return (hash >>> 0).toString(36)
}

// The build record for a compile outcome, tagged with the hash it built. Shared
// by `open` (initial build) and `run`.
function buildRecord(hash: string, diagnostics: string[]): CodeBuild {
	const ok = diagnostics.length === 0
	return {
		hash,
		result: ok ? 'ok' : 'failed',
		diagnostics,
		message: ok ? 'App build successful.' : 'Build failed. Showing last working app.',
		at: Date.now()
	}
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
