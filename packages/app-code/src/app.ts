import { type AppHandle, defineApp } from '@justfiles/app'
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
// The project's app icon, stored verbatim (as an image data URL) at the project
// root — a sibling of `src/`. `project.json` declares it as the app icon, so
// `devkit.install`/`pack` bundle it into the shipped app.
const ICON = (slug: string) => `/projects/${slug}/icon`
// The project file — the build contract devkit reads (identity + where the
// entries and icon live). Lives at the project root beside `src/` and `icon`.
const PROJECT = (slug: string) => `/projects/${slug}/project.json`

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

const buildSchema = v.object({
	hash: v.string(),
	result: v.picklist(['ok', 'failed', 'crashed'] as const),
	diagnostics: v.array(v.string()),
	message: v.string(),
	at: v.number()
})
// The opened-project snapshot the `open` procedure commits in one transition.
const openedSchema = v.object({
	slug: slugSchema,
	files: v.array(v.string()),
	selectedPath: v.nullable(v.string()),
	sourceHash: v.string(),
	build: v.nullable(buildSchema)
})

type CodeCaps = { volume: ReturnType<typeof volume>; devkit: ReturnType<typeof devkit> }

// Adapt the kernel-mediated `app.invoke` into the `VolumeCapability` shape the
// disk helpers (readSource/seed/…) expect — same trust path, typed surface.
function volumeApi(app: AppHandle<CodeState, CodeCaps>): VolumeCapability {
	return {
		readFile: (input) => app.invoke('volume', 'readFile', input),
		writeFile: (input) => app.invoke('volume', 'writeFile', input),
		mkdir: (input) => app.invoke('volume', 'mkdir', input),
		scan: (input) => app.invoke('volume', 'scan', input),
		exists: (input) => app.invoke('volume', 'exists', input)
	}
}

export const app = defineApp({
	init: initialState,
	capabilities: { volume: volume({ scopes: [] }), devkit: devkit({ scopes: [] }) },
	// Pure edges hold the genuine state transitions. The capability-driven work
	// (compile, read, ship) lives in procedures, which commit results through the
	// internal edges below.
	update: (t) => ({
		select: t.on(
			v.object({ path: srcPathSchema }),
			(state, { path }) => {
				const s = normalizeState(state)
				if (!s.files.includes(path) || path === s.selectedPath) return s
				return { ...s, selectedPath: path }
			},
			{ description: 'Open a source file for editing.', examples: [{ params: { path: 'app.ts' } }] }
		),
		setView: t.on(
			v.object({ view: v.picklist(['source', 'app']) }),
			(state, { view }) => {
				const s = normalizeState(state)
				return s.view === view ? s : { ...s, view }
			},
			{
				description: 'Switch between the Source and App views. Never builds.',
				examples: [{ params: { view: 'app' } }]
			}
		),
		// Commit the opened-project snapshot (dispatched by the `open` procedure).
		opened: t.commit(openedSchema, (state, snapshot) => ({
			...normalizeState(state),
			...snapshot
		})),
		// Record a build outcome; leaves `sourceHash` alone (write owns it).
		recordBuild: t.commit(v.object({ build: buildSchema }), (state, { build }) => ({
			...normalizeState(state),
			build
		})),
		// Record the recomputed source hash after a write.
		recordHash: t.commit(v.object({ sourceHash: v.string() }), (state, { sourceHash }) => ({
			...normalizeState(state),
			sourceHash
		}))
	}),
	procedures: (p) => ({
		open: p.procedure({
			description: 'Open a project from app-code storage, seeding it on first use.',
			schema: v.object({ slug: slugSchema }),
			async run({ slug }, app) {
				const state = normalizeState(app.state)
				const vol = volumeApi(app)
				if (!(await vol.exists({ path: SRC(slug) }))) await seed(vol, slug)
				// Backfill the project file for projects created before it existed, so
				// devkit always has its build contract.
				if (!(await vol.exists({ path: PROJECT(slug) }))) await writeProjectManifest(vol, slug)
				const source = await readSource(vol, slug)
				const files = Object.keys(source)
				const selectedPath = files.includes(state.selectedPath ?? '')
					? state.selectedPath
					: (files[0] ?? null)
				// Run the initial build so the App is live on open, resuming the draft's
				// persisted runtime state (no reset). devkit reads the source off disk.
				const hash = hashSource(source)
				const { diagnostics } = await app.invoke('devkit', 'run', { slug })
				const { seq } = await app.dispatch({
					type: 'opened',
					params: {
						slug,
						files,
						selectedPath,
						sourceHash: hash,
						build: buildRecord(hash, diagnostics)
					}
				})
				return app.settled(seq)
			}
		}),
		// Persist the bytes and recompute `sourceHash`. Fast; no compile; does not
		// touch `build`. Clients write as many files as they need, then `run` once.
		write: p.procedure({
			description: 'Persist a source file and recompute the source hash.',
			schema: v.object({ path: srcPathSchema, content: v.string() }),
			async run({ path, content }, app) {
				const state = normalizeState(app.state)
				const vol = volumeApi(app)
				await vol.writeFile({ path: SRC(state.slug, `/${path}`), data: encoder.encode(content) })
				const { seq } = await app.dispatch({
					type: 'recordHash',
					params: { sourceHash: hashSource(await readSource(vol, state.slug)) }
				})
				return app.settled(seq)
			}
		}),
		// Read the freshest source from disk, hash it, compile + mount via
		// `devkit.run`, and record the outcome tagged with the hash it built. Leaves
		// `sourceHash` alone (write owns it), so a write that lands mid-run shows up
		// as `updating` afterward. `reset` wipes the draft's persisted state.
		run: p.procedure({
			description: 'Compile the current source and run it as the live App.',
			schema: v.object({ reset: v.optional(v.boolean()) }),
			async run({ reset }, app) {
				const state = normalizeState(app.state)
				const hash = hashSource(await readSource(volumeApi(app), state.slug))
				const { diagnostics } = await app.invoke('devkit', 'run', { slug: state.slug, reset })
				const { seq } = await app.dispatch({
					type: 'recordBuild',
					params: { build: buildRecord(hash, diagnostics) }
				})
				return app.settled(seq)
			}
		}),
		// Internal cleanup only (unmount); `previewId` is a pure function of the slug.
		stop: p.procedure({
			description: 'Tear down the running App.',
			schema: v.object({}),
			async run(_, app) {
				await app.invoke('devkit', 'stop', {
					previewId: `preview.${normalizeState(app.state).slug}`
				})
			}
		}),
		readFile: p.procedure({
			description: 'Read a source file as text.',
			schema: v.object({ path: srcPathSchema }),
			async run({ path }, app) {
				const state = normalizeState(app.state)
				return decoder.decode(
					await app.invoke('volume', 'readFile', { path: SRC(state.slug, `/${path}`) })
				)
			}
		}),
		// The project's app icon as an image data URL, or null if unset. Drives the
		// preview Dock's icon tile (the icon editor).
		readIcon: p.procedure({
			description: "Read the project's app icon as an image data URL.",
			schema: v.object({}),
			async run(_, app): Promise<string | null> {
				const path = ICON(normalizeState(app.state).slug)
				if (!(await app.invoke('volume', 'exists', { path }))) return null
				return decoder.decode(await app.invoke('volume', 'readFile', { path }))
			}
		}),
		// Set the project's app icon from an image data URL (verbatim — no resize).
		writeIcon: p.procedure({
			description: "Set the project's app icon from an image data URL.",
			schema: v.object({ dataUrl: v.pipe(v.string(), v.startsWith('data:image/')) }),
			async run({ dataUrl }, app) {
				await app.invoke('volume', 'writeFile', {
					path: ICON(normalizeState(app.state).slug),
					data: encoder.encode(dataUrl)
				})
			}
		}),
		// The live App's declared menubar (display structure only), pulled so the
		// preview window can draw it on top with the shared design CSS. Empty until
		// the App mounts or if it declares no menus.
		menu: p.procedure({
			description: "Read the live App's declared menubar for the preview window.",
			schema: v.object({}),
			run: (_, app) =>
				app.invoke('devkit', 'menu', { previewId: `preview.${normalizeState(app.state).slug}` })
		}),
		// Fire a preview menubar item by position; devkit invokes the real action
		// against the live App on the main thread. No state of our own changes.
		selectMenu: p.procedure({
			description: 'Fire a preview menubar item against the live App.',
			schema: v.object({ menu: v.number(), item: v.number() }),
			async run({ menu, item }, app) {
				await app.invoke('devkit', 'selectMenu', {
					previewId: `preview.${normalizeState(app.state).slug}`,
					menu,
					item
				})
			}
		}),
		// Ship: promote the project to the real `/applications` as a standalone app.
		// devkit reads the source + icon off disk, compiles fresh, and rejects a
		// colliding id (its guard). Returns the installed id; our own state is unchanged.
		install: p.procedure({
			description: 'Compile the current source and install it as a real app.',
			schema: v.object({}),
			run: (_, app) => app.invoke('devkit', 'install', { slug: normalizeState(app.state).slug })
		}),
		// Share: compile fresh and return a downloadable `.zip` of the bundle; the
		// gui turns the bytes into a file download.
		pack: p.procedure({
			description: 'Compile the current source and return a downloadable .zip bundle.',
			schema: v.object({}),
			run: (_, app) => app.invoke('devkit', 'pack', { slug: normalizeState(app.state).slug })
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
	await writeProjectManifest(volume, slug)
}

// Write the project file devkit builds from. id/name default to the slug (a
// valid app id; the author edits `project.json` to claim a real reverse-DNS id);
// the entries and icon path declare the layout explicitly.
async function writeProjectManifest(volume: VolumeCapability, slug: string): Promise<void> {
	const manifest = { id: slug, name: slug, icon: 'icon', app: 'src/app.ts', gui: 'src/gui.ts' }
	await volume.writeFile({
		path: PROJECT(slug),
		data: encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`)
	})
}

const starterApp = `import { defineApp } from '@justfiles/app'
import * as v from 'valibot'

export type CounterState = {
	count: number
}

export const app = defineApp({
	init: { count: 0 } as CounterState,
	update: (t) => ({
		increment: t.on(v.object({}), (state) => ({ count: state.count + 1 }))
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
	},
	// Declared menus show in the preview window's menubar and run against the live
	// app. 'Even' reflects state — it re-checks as the count changes.
	menu: (state, client) => [
		{
			title: 'Count',
			items: [
				{ title: 'Increment', shortcut: '⌘I', onSelect: () => void client.increment({}) },
				{ separator: true },
				{ title: 'Even', checked: (state?.count ?? 0) % 2 === 0, disabled: true, onSelect: () => {} }
			]
		}
	]
})
`

export type CodeApp = typeof app
