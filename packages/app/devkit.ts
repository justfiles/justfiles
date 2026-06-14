// The devkit build pipeline: compile a draft's `src/*` against the system
// runtime, and build / install / pack it. Host-agnostic — the esbuild engine and
// the pre-bundled system `runtime` are INJECTED (a `Toolchain`), so this module
// has only a type-only esbuild import and is safe to pull into a browser host
// (frieren) as well as a Node host (desktop). The matching `runtime` is produced
// by `buildRuntime` in the Node-only `@justfiles/app/devkit-runtime` subpath.
//
// A devkit project is a directory in a caller's data volume: a `project.json`
// build contract (an `AppManifest` whose entry paths point at the `src/*`
// sources) plus the source tree and an optional icon file. Callers name the
// project by `slug`; the pipeline reads the tree off the supplied volume.

import { chroot, type Volume } from '@justfiles/fs'
import { FileType } from '@justfiles/fs/types'
import type { BuildOptions, BuildResult, Loader, Message, Plugin } from 'esbuild'
import { strToU8, zipSync } from 'fflate'
import { type AppManifest, appBundleFromMemory, type Kernel, safeBundlePath } from './kernel.ts'
import { isReactGuiEntry, reactGuiEntry } from './react-entry.ts'

export type BuildFn = (options: BuildOptions) => Promise<BuildResult>

// The injected toolchain: the esbuild `build` engine (native esbuild on a Node
// host; `esbuild-wasm` in a browser host) plus the pre-bundled system libraries
// keyed by import specifier.
export type Toolchain = { build: BuildFn; runtime: Record<string, string> }

export interface CompileResult {
	app: string
	gui: string
	diagnostics: string[]
}

// The entry source paths, declared by the project file (keys into `files`). The
// project owns its layout — compile never guesses where the entries live.
export interface CompileEntries {
	app: string
	gui?: string
}

// A compiled draft: its identity (from `project.json`), the two compiled entries
// (empty on failure), the optional icon data URL, and any compile diagnostics.
export interface DraftBuild {
	manifest: AppManifest
	app: string
	gui: string
	icon?: string
	diagnostics: string[]
}

// React stays external (resolved through the host importmap) so a preview shares
// the one host React instance. Mirrors the list `buildRuntime` keeps external.
const EXTERNAL = [
	'react',
	'react-dom',
	'react-dom/client',
	'react/jsx-runtime',
	'react/jsx-dev-runtime'
]

const VFS = 'devkit-vfs'
const RUNTIME = 'devkit-runtime'
const REACT_GUI_ENTRY = '__react_gui_entry.ts'
const PROJECT_FILE = 'project.json'

// esbuild bundles a draft's `app.ts` (headless reducer) and `gui.ts` (browser UI)
// the same way `kernelHost` does at ship time. `compile` is pure: the caller
// injects the esbuild engine and the `runtime` map of pre-bundled system
// libraries. The vfs resolver serves the draft's own files plus those system
// libs; any other bare import is left unresolved on purpose — drafts compile
// hermetically against the provided stdlib only.
export async function compile(
	files: Record<string, string>,
	entries: CompileEntries,
	build: BuildFn,
	runtime: Record<string, string>
): Promise<CompileResult> {
	const diagnostics: string[] = []
	const one = async (entry: string, sources = files): Promise<string> => {
		try {
			const result = await build({
				entryPoints: [entry],
				bundle: true,
				write: false,
				format: 'esm',
				external: EXTERNAL,
				jsx: 'automatic',
				logLevel: 'silent',
				plugins: [vfs(sources, runtime)]
			})
			return result.outputFiles?.[0]?.text ?? ''
		} catch (error) {
			diagnostics.push(...messagesOf(error))
			return ''
		}
	}
	const present = (entry: string | undefined): entry is string => !!entry && entry in files
	if (!present(entries.app)) diagnostics.push(`missing entry: ${entries.app}`)
	if (entries.gui && !present(entries.gui)) diagnostics.push(`missing entry: ${entries.gui}`)
	const app = present(entries.app) ? await one(entries.app) : ''
	let gui = ''
	if (present(entries.gui)) {
		const wrapReactGui = isReactGuiEntry(entries.gui)
		const sources = wrapReactGui
			? { ...files, [REACT_GUI_ENTRY]: reactGuiEntry(`./${entries.gui}`) }
			: files
		gui = await one(wrapReactGui ? REACT_GUI_ENTRY : entries.gui, sources)
	}
	return { app, gui, diagnostics }
}

function vfs(files: Record<string, string>, runtime: Record<string, string>): Plugin {
	return {
		name: 'devkit-vfs',
		setup(build) {
			build.onResolve({ filter: /.*/ }, (args) => {
				if (args.kind === 'entry-point') return { path: args.path, namespace: VFS }
				if (args.path.startsWith('.')) {
					const resolved = resolveRelative(args.importer, args.path, files)
					return resolved ? { path: resolved, namespace: VFS } : undefined
				}
				// A pre-bundled system library; side-effect-free so unused exports
				// (e.g. the kernel half of `@justfiles/app`) tree-shake away.
				if (args.path in runtime) return { path: args.path, namespace: RUNTIME, sideEffects: false }
				return undefined
			})
			build.onLoad({ filter: /.*/, namespace: VFS }, (args) => ({
				contents: files[args.path] ?? '',
				loader: loaderFor(args.path)
			}))
			build.onLoad({ filter: /.*/, namespace: RUNTIME }, (args) => ({
				contents: runtime[args.path],
				loader: 'js'
			}))
		}
	}
}

function resolveRelative(
	importer: string,
	spec: string,
	files: Record<string, string>
): string | undefined {
	const baseDir = importer.includes('/') ? importer.slice(0, importer.lastIndexOf('/')) : ''
	const parts = baseDir ? baseDir.split('/') : []
	for (const seg of spec.split('/')) {
		if (seg === '' || seg === '.') continue
		if (seg === '..') parts.pop()
		else parts.push(seg)
	}
	const joined = parts.join('/')
	const candidates = [joined, `${joined}.ts`, `${joined}.tsx`, `${joined}.js`, `${joined}/index.ts`]
	return candidates.find((candidate) => candidate in files)
}

function loaderFor(path: string): Loader {
	if (path.endsWith('.tsx')) return 'tsx'
	if (path.endsWith('.jsx')) return 'jsx'
	if (path.endsWith('.js')) return 'js'
	if (path.endsWith('.json')) return 'json'
	return 'ts'
}

function messagesOf(error: unknown): string[] {
	const errors = (error as { errors?: Message[] }).errors
	if (Array.isArray(errors) && errors.length > 0) {
		return errors.map((message) => {
			const loc = message.location ? ` (${message.location.file}:${message.location.line})` : ''
			return `${message.text}${loc}`
		})
	}
	return [error instanceof Error ? error.message : String(error)]
}

// ── Draft build / install / pack ──────────────────────────────────────────
//
// `buildDraft` reads + compiles a project from a caller's data volume (`data`,
// chrooted to `/data/<appId>`). `installDraft`/`packDraft` build on it and never
// ship a bad build (they throw the diagnostics). The host owns the kernel
// instance and the post-install hook; the live-preview MOUNT stays host-side.

// Read + compile the named project off `data` (chrooted to the caller's data
// dir). Never throws on a compile error — diagnostics ride back so a live
// preview can keep its last-good mount; only a missing/invalid `project.json`
// throws.
export async function buildDraft(data: Volume, slug: string, tc: Toolchain): Promise<DraftBuild> {
	const manifest = await readProjectFile(data, slug)
	const files = await projectFiles(data, slug, manifest)
	const { app, gui, diagnostics } = await compile(files, entriesOf(manifest), tc.build, tc.runtime)
	const icon = await projectIcon(data, slug, manifest.icon)
	return { manifest, app, gui, icon, diagnostics }
}

// Compile + promote the project to the REAL `/applications` via the host's
// `kernel`. By default install only ever creates — re-shipping an existing id is
// rejected (guarded check-first on the live catalog). `opts.overwrite` lifts the
// guard so a re-install updates the live app in place (the store backs up and
// atomically replaces the bundle; the kernel re-warms its streams). The
// project's icon, if any, is bundled. `opts.onInstalled` lets the host re-list
// its catalog. Identity comes from the project file, so the installed id is the
// author's.
export async function installDraft(
	fs: Volume,
	appId: string,
	slug: string,
	kernel: Kernel,
	tc: Toolchain,
	opts?: { onInstalled?: () => void | Promise<void>; overwrite?: boolean }
): Promise<{ id: string }> {
	const { manifest, app, gui, icon } = assertBuilt(
		await buildDraft(chroot(fs, `/data/${appId}`), slug, tc)
	)
	if (!opts?.overwrite && (await kernel.list()).some((installed) => installed.id === manifest.id)) {
		throw new Error(`app id already exists: ${manifest.id}`)
	}
	await kernel.install(
		appBundleFromMemory({
			id: manifest.id,
			name: manifest.name,
			description: manifest.description,
			version: manifest.version,
			app,
			gui,
			...iconBundle(icon)
		})
	)
	await opts?.onInstalled?.()
	return { id: manifest.id }
}

// Compile + emit a downloadable `.zip` of the bundle — `manifest.json` at the
// root plus the two compiled entries (and the icon, if any), the exact shape the
// launcher's `bundleFromZip` import path expects.
export async function packDraft(
	data: Volume,
	slug: string,
	tc: Toolchain
): Promise<{ zip: Uint8Array }> {
	const { manifest, app, gui, icon } = assertBuilt(await buildDraft(data, slug, tc))
	// The bundle manifest: the project file with entries swapped to their compiled
	// paths and the icon normalised to a single bundled file.
	const bundleManifest = {
		id: manifest.id,
		name: manifest.name,
		...(manifest.description ? { description: manifest.description } : {}),
		...(manifest.version ? { version: manifest.version } : {}),
		app: 'app.js',
		gui: 'gui.js',
		...iconManifest(icon)
	}
	const entries: Record<string, Uint8Array> = {
		'manifest.json': strToU8(JSON.stringify(bundleManifest, null, 2)),
		'app.js': strToU8(app),
		'gui.js': strToU8(gui)
	}
	if (icon) entries[ICON_FILE] = strToU8(icon)
	return { zip: zipSync(entries) }
}

// A draft that must ship: unlike a preview, a bad build can't be promoted, so
// surface the diagnostics (or the missing-output case) as a thrown error.
function assertBuilt(draft: DraftBuild): DraftBuild {
	if (draft.diagnostics.length > 0)
		throw new Error(`Build failed:\n${draft.diagnostics.join('\n')}`)
	if (!draft.app || !draft.gui)
		throw new Error('Build produced no output (need an app + gui entry).')
	return draft
}

// Read + validate the project file. The only convention between devkit and the
// authoring app: a project is a directory holding a `project.json`. Required
// `id`/`name`/`app`; declared paths are confined to the project dir.
async function readProjectFile(data: Volume, slug: string): Promise<AppManifest> {
	const path = `/projects/${slug}/${PROJECT_FILE}`
	if (!(await data.exists(path))) throw new Error(`${PROJECT_FILE} not found for project: ${slug}`)
	let raw: unknown
	try {
		raw = JSON.parse(new TextDecoder().decode(await data.readFile(path)))
	} catch {
		throw new Error(`${PROJECT_FILE} is not valid JSON`)
	}
	const m = raw as Record<string, unknown>
	if (typeof m?.id !== 'string' || typeof m.name !== 'string' || typeof m.app !== 'string') {
		throw new Error(`${PROJECT_FILE} must declare string "id", "name" and "app"`)
	}
	return {
		id: m.id,
		name: m.name,
		app: safeBundlePath(m.app),
		gui: optionalPath(m.gui, 'gui'),
		icon: optionalPath(m.icon, 'icon'),
		version: typeof m.version === 'string' ? m.version : undefined,
		description: typeof m.description === 'string' ? m.description : undefined
	}
}

function optionalPath(value: unknown, field: string): string | undefined {
	if (value === undefined) return undefined
	if (typeof value !== 'string') throw new Error(`${PROJECT_FILE} "${field}" must be a path string`)
	return safeBundlePath(value)
}

const entriesOf = (manifest: AppManifest): CompileEntries => ({
	app: manifest.app,
	gui: manifest.gui
})

// Read the project's source tree into the path→content map the compiler wants,
// keyed by project-relative path (matching the entry paths the manifest
// declares). The project file and the (potentially large) icon are skipped —
// they aren't source.
async function projectFiles(
	data: Volume,
	slug: string,
	manifest: AppManifest
): Promise<Record<string, string>> {
	const root = `/projects/${slug}`
	const skip = new Set([PROJECT_FILE, manifest.icon].filter((name): name is string => !!name))
	const files: Record<string, string> = {}
	if (await data.exists(root)) {
		await data.scan(root, async (path, stat) => {
			if (stat.type === FileType.Directory || stat.type === FileType.Symlink) return
			const rel = path.slice(root.length + 1)
			if (!skip.has(rel)) files[rel] = new TextDecoder().decode(await data.readFile(path))
		})
	}
	return files
}

// The project's declared icon (an image data URL), or undefined when unset/absent.
async function projectIcon(
	data: Volume,
	slug: string,
	iconPath?: string
): Promise<string | undefined> {
	if (!iconPath) return undefined
	const path = `/projects/${slug}/${iconPath}`
	return (await data.exists(path)) ? new TextDecoder().decode(await data.readFile(path)) : undefined
}

// The bundle's icon is the project's image data URL, stored verbatim as a single
// self-describing file (`manifest.icon` points at it). Omitted when no icon.
const ICON_FILE = 'icon'
function iconBundle(icon?: string): { icon?: string; assets?: Record<string, string> } {
	return icon ? { icon: ICON_FILE, assets: { [ICON_FILE]: icon } } : {}
}
function iconManifest(icon?: string): { icon?: string } {
	return icon ? { icon: ICON_FILE } : {}
}
