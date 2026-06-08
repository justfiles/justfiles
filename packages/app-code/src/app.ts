import { type AppHandle, defineApp } from '@justfiles/app'
import { devkit } from '@justfiles/app/capabilities/devkit'
import { volume } from '@justfiles/app/capabilities/volume'
import * as v from 'valibot'
import {
	bundleIdSchema,
	createProject,
	ICON,
	listProjects,
	PROJECT,
	projectName,
	readMeta,
	SRC,
	saveMeta,
	type VolumeApi,
	writeProjectManifest
} from './projects.ts'

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
	// null → gallery (no project open); set → editor for that project. When set,
	// slug IS the project's bundle id (folder = id); permanent once created.
	slug: string | null
	name: string // friendly display name of the open project ('' when none)
	selectedPath: string | null
	view: CodeView
	// content identity + last build; both are honest functions of the files on disk
	files: string[] // cache of the disk scan, refreshed by open
	sourceHash: string // hash of the current source on disk
	build: CodeBuild | null
}

export const initialState: CodeState = {
	slug: null, // launch into the gallery, not a fixed project
	name: '',
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

// `name` is required so a pre-`name` persisted state is rebuilt by
// `normalizeState` (name defaulted) rather than passed through missing the field.
export function isCodeState(value: unknown): value is CodeState {
	return (
		!!value &&
		typeof value === 'object' &&
		'slug' in value &&
		'name' in value &&
		'files' in value &&
		'view' in value
	)
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

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
	name: v.string(),
	files: v.array(v.string()),
	selectedPath: v.nullable(v.string()),
	sourceHash: v.string(),
	build: v.nullable(buildSchema)
})

type CodeCaps = { volume: ReturnType<typeof volume>; devkit: ReturnType<typeof devkit> }

// Adapt the kernel-mediated `app.invoke` into the `VolumeApi` shape the disk
// helpers (readSource/seed/…) expect — same trust path, typed surface. Args are
// spread positionally now; only `scan` keeps an object (it is the bespoke,
// listing-returning method, not part of `Volume`).
function volumeApi(app: AppHandle<CodeState, CodeCaps>): VolumeApi {
	return {
		readFile: (path) => app.invoke('volume', 'readFile', path),
		writeFile: (path, data) => app.invoke('volume', 'writeFile', path, data),
		mkdir: (path, opts) => app.invoke('volume', 'mkdir', path, opts),
		scan: (input) => app.invoke('volume', 'scan', input),
		exists: (path) => app.invoke('volume', 'exists', path),
		rm: (path, opts) => app.invoke('volume', 'rm', path, opts),
		rename: (oldPath, newPath) => app.invoke('volume', 'rename', oldPath, newPath)
	}
}

// Reject the no-project (gallery) state before any path is derived from the slug,
// so no editor-only procedure builds a `/projects/null/…` path.
function reqSlug(app: AppHandle<CodeState, CodeCaps>): string {
	const { slug } = normalizeState(app.state)
	if (!slug) throw new Error('no project open')
	return slug
}

export const app = defineApp({
	init: initialState,
	capabilities: { volume: volume({ scopes: [] }), devkit: devkit({ scopes: [] }) },
	// Watch the open source file (Part D) so a foreign change to it is caught
	// instead of being silently overwritten. Guarded on `slug` too: the gallery
	// (slug null) builds no path, so it declares no watch.
	subscriptions: (state, sub) => {
		const s = normalizeState(state)
		return s.slug && s.selectedPath
			? [
					sub
						.capability('volume', 'watch', { path: SRC(s.slug, `/${s.selectedPath}`) })
						.to('fileChanged')
				]
			: []
	},
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
		// Close the project and return to the gallery (slug → null).
		close: t.on(
			v.object({}),
			(state) => ({
				...normalizeState(state),
				slug: null,
				name: '',
				selectedPath: null,
				build: null
			}),
			{ description: 'Close the project and return to the gallery.' }
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
		})),
		// Keep CodeState.name (toolbar / window title / preview menubar) in sync
		// after the settings screen rewrites the manifest.
		recordName: t.commit(v.object({ name: v.string() }), (state, { name }) => ({
			...normalizeState(state),
			name
		})),
		// The open source file changed on disk (Part D). A foreign-sourced write —
		// e.g. the agent editing the project from elsewhere — must not be silently
		// reloaded over unsaved edits nor silently overwritten by the next save, so
		// we make it loud: throw, which surfaces as an app error. The editor's own
		// local saves carry no `source` and are ignored (no churn). Graceful handling
		// (reload / diff against the editor buffer) is a deferred product decision.
		fileChanged: t.fromEvent('volume', 'watch', (state, event) => {
			const s = normalizeState(state)
			if (event.source)
				throw new Error(
					`Source file "${s.selectedPath}" changed on disk outside the editor. Reopen the project to reload — saving now would overwrite that change.`
				)
			return s
		})
	}),
	procedures: (p) => ({
		// Names-only gallery listing of `/projects`.
		listProjects: p.procedure({
			description: 'List the projects in app-code storage.',
			schema: v.object({}),
			run: (_, app) => listProjects(volumeApi(app))
		}),
		// Create a new project by name + bundle id, then return its slug (the id).
		// The GUI follows up with `open({ slug })`. Seeding lives here, not in `open`.
		create: p.procedure({
			description: 'Create a new project by name and bundle id.',
			schema: v.object({
				name: v.pipe(v.string(), v.trim(), v.minLength(1)),
				id: bundleIdSchema,
				template: v.optional(v.picklist(['react', 'vanilla']), 'react')
			}),
			run: ({ name, id, template }, app) => createProject(volumeApi(app), name, id, template)
		}),
		// Load (not build) an existing project: read its name, scan files, compute
		// the hash, and commit the opened snapshot with `build: null`. It does NOT
		// call `devkit.run` — gallery and editor are separate views, so at `open`
		// time there is no `[data-preview-slot]` yet; the GUI renders the editor,
		// then calls `run({})` for the first build. Backfills the project file for
		// legacy projects (`untitled`) created before it existed.
		open: p.procedure({
			description: 'Open an existing project from app-code storage.',
			schema: v.object({ slug: slugSchema }),
			async run({ slug }, app) {
				const state = normalizeState(app.state)
				const vol = volumeApi(app)
				if (!(await vol.exists(PROJECT(slug)))) await writeProjectManifest(vol, slug)
				const name = await projectName(vol, slug)
				const source = await readSource(vol, slug)
				const files = Object.keys(source)
				const selectedPath = files.includes(state.selectedPath ?? '')
					? state.selectedPath
					: (files[0] ?? null)
				const { seq } = await app.dispatch({
					type: 'opened',
					params: {
						slug,
						name,
						files,
						selectedPath,
						sourceHash: hashSource(source),
						build: null
					}
				})
				return app.settled(seq)
			}
		}),
		// Read the open project's manifest to populate the settings form.
		readMeta: p.procedure({
			description: "Read the open project's metadata (name, version, description).",
			schema: v.object({}),
			run: (_, app) => readMeta(volumeApi(app), reqSlug(app))
		}),
		// Rewrite name/version/description on disk, then record the name so the
		// toolbar / window title / preview menubar refresh from the pushed state.
		// The bundle id is immutable in v1, so the folder never moves (no reopen).
		saveMeta: p.procedure({
			description: "Update the open project's metadata.",
			schema: v.object({
				name: v.pipe(v.string(), v.trim(), v.minLength(1)),
				version: v.optional(v.string()),
				description: v.optional(v.string())
			}),
			async run(fields, app) {
				const slug = reqSlug(app)
				await saveMeta(volumeApi(app), slug, fields)
				const { seq } = await app.dispatch({ type: 'recordName', params: { name: fields.name } })
				return app.settled(seq)
			}
		}),
		// Persist the bytes and recompute `sourceHash`. Fast; no compile; does not
		// touch `build`. Clients write as many files as they need, then `run` once.
		write: p.procedure({
			description: 'Persist a source file and recompute the source hash.',
			schema: v.object({ path: srcPathSchema, content: v.string() }),
			async run({ path, content }, app) {
				const slug = reqSlug(app)
				const vol = volumeApi(app)
				await vol.writeFile(SRC(slug, `/${path}`), encoder.encode(content))
				const { seq } = await app.dispatch({
					type: 'recordHash',
					params: { sourceHash: hashSource(await readSource(vol, slug)) }
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
				const slug = reqSlug(app)
				const hash = hashSource(await readSource(volumeApi(app), slug))
				const { diagnostics } = await app.invoke('devkit', 'run', { slug, reset })
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
				await app.invoke('devkit', 'stop', { previewId: `preview.${reqSlug(app)}` })
			}
		}),
		readFile: p.procedure({
			description: 'Read a source file as text.',
			schema: v.object({ path: srcPathSchema }),
			async run({ path }, app) {
				return decoder.decode(await app.invoke('volume', 'readFile', SRC(reqSlug(app), `/${path}`)))
			}
		}),
		// The project's app icon as an image data URL, or null if unset. Drives the
		// preview Dock's icon tile (the icon editor).
		readIcon: p.procedure({
			description: "Read the project's app icon as an image data URL.",
			schema: v.object({}),
			async run(_, app): Promise<string | null> {
				const path = ICON(reqSlug(app))
				if (!(await app.invoke('volume', 'exists', path))) return null
				return decoder.decode(await app.invoke('volume', 'readFile', path))
			}
		}),
		// Set the project's app icon from an image data URL (verbatim — no resize).
		writeIcon: p.procedure({
			description: "Set the project's app icon from an image data URL.",
			schema: v.object({ dataUrl: v.pipe(v.string(), v.startsWith('data:image/')) }),
			async run({ dataUrl }, app) {
				await app.invoke('volume', 'writeFile', ICON(reqSlug(app)), encoder.encode(dataUrl))
			}
		}),
		// The live App's declared menubar (display structure only), pulled so the
		// preview window can draw it on top with the shared design CSS. Empty until
		// the App mounts or if it declares no menus.
		menu: p.procedure({
			description: "Read the live App's declared menubar for the preview window.",
			schema: v.object({}),
			run: (_, app) => app.invoke('devkit', 'menu', { previewId: `preview.${reqSlug(app)}` })
		}),
		// Fire a preview menubar item by position; devkit invokes the real action
		// against the live App on the main thread. No state of our own changes.
		selectMenu: p.procedure({
			description: 'Fire a preview menubar item against the live App.',
			schema: v.object({ menu: v.number(), item: v.number() }),
			async run({ menu, item }, app) {
				await app.invoke('devkit', 'selectMenu', {
					previewId: `preview.${reqSlug(app)}`,
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
			run: (_, app) => app.invoke('devkit', 'install', { slug: reqSlug(app) })
		}),
		// Share: compile fresh and return a downloadable `.zip` of the bundle; the
		// gui turns the bytes into a file download.
		pack: p.procedure({
			description: 'Compile the current source and return a downloadable .zip bundle.',
			schema: v.object({}),
			run: (_, app) => app.invoke('devkit', 'pack', { slug: reqSlug(app) })
		})
	})
})

// Coerce ctx.state into the current shape on every handler. New-shape state
// passes through untouched (so a `run`'s build survives later handlers). Old
// persisted state is migrated: `rightPane` → `view`, `name` defaulted, everything
// runtime reset (`build` null, `sourceHash` '') — `open` recomputes the hash. A
// persisted `slug` is preserved (not nulled here, or `open` could never set it);
// the launch reset to the gallery lives in the GUI (a `close` on mount).
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

async function listFiles(volume: VolumeApi, slug: string): Promise<string[]> {
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
async function readSource(volume: VolumeApi, slug: string): Promise<Record<string, string>> {
	const files = await listFiles(volume, slug)
	const entries = await Promise.all(
		files.map(
			async (path) => [path, decoder.decode(await volume.readFile(SRC(slug, `/${path}`)))] as const
		)
	)
	return Object.fromEntries(entries)
}

export type CodeApp = typeof app
