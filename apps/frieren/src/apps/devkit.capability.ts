import { type AppManifest, appBundleFromMemory, safeBundlePath } from '@justfiles/app'
import { CapabilityError } from '@justfiles/app/capabilities'
import type { MenuView } from '@justfiles/app/capabilities/devkit'
import { chroot, type Volume } from '@justfiles/fs'
import { FileType } from '@justfiles/fs/types'
import { strToU8, zipSync } from 'fflate'
import { type CompileEntries, compile } from '../../shared/devkit.compile'
import * as host from './host'
import { createClientKernel } from './kernel.client'

// Local, main-thread `devkit` capability impl. It holds the toolchain
// (esbuild-wasm + the system runtime) and the host natively, so it can compile
// a draft, run it in a kernel scoped to the caller's private scratch folder,
// and parent the live app at the caller's own `[data-preview-slot]`. The caller
// only ever names the project (`slug`); devkit reads its `project.json` (the
// build contract — id/name/entries/icon) and source tree straight off the
// caller's own data dir, so the files never cross the worker boundary — the
// reducer only exchanges a slug, ids, diagnostics and zip bytes. The app renders
// its own preview chrome; `menu` just hands it the live menu data to draw (see
// contract). Routed only for allowlisted apps (see capabilities.client /
// devkit.allowlist).

type GetToken = () => Promise<string | null>
type RunInput = { slug: string; reset?: boolean }
type Toolchain = { build: Parameters<typeof compile>[2]; runtime: Record<string, string> }
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes)

// The project file: a devkit project's build contract. It declares the app's
// identity and where the entries + icon live, so the folder layout is never a
// silent agreement between devkit and the authoring app. It IS an `AppManifest`
// — the source-side mirror of the bundle's `manifest.json`: here the entry paths
// point at the `src/*.ts` sources; the bundle's at the compiled `*.js`.
const PROJECT_FILE = 'project.json'

// esbuild-wasm initialises once per page; the system runtime bundle loads with
// it. Both are pulled lazily so a session that never runs a draft pays nothing.
let toolchain: Promise<Toolchain> | undefined
function getToolchain(): Promise<Toolchain> {
	toolchain ??= (async () => {
		const esbuild = await import('esbuild-wasm')
		const { default: wasmURL } = await import('esbuild-wasm/esbuild.wasm?url')
		await esbuild.initialize({ wasmURL })
		const { runtime } = await import('virtual:devkit-runtime')
		return { build: esbuild.build, runtime }
	})()
	return toolchain
}

export async function invokeDevkit(
	fs: Volume,
	getToken: GetToken,
	req: { method: string; input: unknown; appId: string }
): Promise<unknown> {
	switch (req.method) {
		case 'run':
			return run(fs, getToken, req.appId, runInput(req.input))
		case 'stop':
			return stop(stopInput(req.input))
		case 'menu':
			return menu(menuInput(req.input))
		case 'selectMenu':
			return selectMenu(selectMenuInput(req.input))
		case 'install':
			return install(fs, getToken, req.appId, slugInput(req.input, 'install'))
		case 'pack':
			return pack(fs, req.appId, slugInput(req.input, 'pack'))
		default:
			throw new CapabilityError('CAPABILITY_UNAVAILABLE', 'devkit', req.method)
	}
}

async function run(
	fs: Volume,
	getToken: GetToken,
	appId: string,
	{ slug, reset }: RunInput
): Promise<{ previewId: string; diagnostics: string[] }> {
	const previewId = `preview.${slug}`
	const manifest = await readProjectFile(fs, appId, slug)
	const { build, runtime } = await getToolchain()
	const { app, gui, diagnostics } = await compile(
		await projectFiles(fs, appId, slug, manifest),
		entriesOf(manifest),
		build,
		runtime
	)
	// Compile failed — leave the last-good preview mounted and surface the errors.
	if (diagnostics.length > 0 || !app || !gui) return { previewId, diagnostics }

	const scoped = chroot(fs, `/data/${appId}/.devkit/${slug}`)
	const kernel = createClientKernel({ fs: scoped, getToken })
	await kernel.install(appBundleFromMemory({ id: previewId, name: manifest.name, app, gui }))
	host.close(previewId) // restart-safe: drop any prior isolate + stage
	// ⟳ Run/Restart: wipe persisted draft state so the next boot starts clean.
	// Done after close (old isolate gone, can't re-persist) and before open.
	if (reset) await scoped.rm(`/state/${previewId}.json`, { force: true })
	host.open(previewId, {
		getToken,
		localKernel: async () => kernel,
		volume: Promise.resolve(scoped)
	})
	// Parent the preview's stage at the caller's own content slot — same
	// document, same thread. The host created the wrapper synchronously in
	// open(); its async boot then mounts the gui into it. The app draws its own
	// window/menubar chrome around this slot (using the shared design CSS).
	const slot = host.wrapperOf(appId)?.querySelector('[data-preview-slot]')
	const child = host.wrapperOf(previewId)
	if (slot && child) slot.replaceChildren(child)
	return { previewId, diagnostics }
}

async function stop({ previewId }: { previewId: string }): Promise<void> {
	host.close(previewId)
}

// Compile + promote the project to the REAL `/applications` via a kernel rooted
// at the unscoped profile volume (the same write the launcher's zip-import does).
// Guarded check-first on the live catalog: install only ever creates, never
// overwrites — re-shipping an existing id is rejected, not silently clobbered.
// `notifyCatalog` wakes the launcher to re-list. Identity comes from the project
// file, so the installed app id is the author's, not the folder slug.
async function install(
	fs: Volume,
	getToken: GetToken,
	appId: string,
	{ slug }: { slug: string }
): Promise<{ id: string }> {
	const manifest = await readProjectFile(fs, appId, slug)
	const { app, gui } = await compiled(
		await projectFiles(fs, appId, slug, manifest),
		entriesOf(manifest)
	)
	const icon = await projectIcon(fs, appId, slug, manifest.icon)
	const kernel = createClientKernel({ fs, getToken })
	if ((await kernel.list()).some((installed) => installed.id === manifest.id)) {
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
	host.notifyCatalog()
	return { id: manifest.id }
}

// Compile + emit a downloadable `.zip` of the bundle — `manifest.json` at the
// root plus the two compiled entries (and the icon, if any), the exact shape the
// launcher's existing `installZipApp` / `bundleFromZip` import path expects.
async function pack(
	fs: Volume,
	appId: string,
	{ slug }: { slug: string }
): Promise<{ zip: Uint8Array }> {
	const manifest = await readProjectFile(fs, appId, slug)
	const { app, gui } = await compiled(
		await projectFiles(fs, appId, slug, manifest),
		entriesOf(manifest)
	)
	const icon = await projectIcon(fs, appId, slug, manifest.icon)
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

// Read + validate the project file. The only convention left between devkit and
// the authoring app: a project is a directory holding a `project.json` (app-code
// seeds and backfills it). Required `id`/`name`/`app`; declared paths are
// confined to the project dir.
async function readProjectFile(fs: Volume, appId: string, slug: string): Promise<AppManifest> {
	const data = chroot(fs, `/data/${appId}`)
	const path = `/projects/${slug}/${PROJECT_FILE}`
	if (!(await data.exists(path))) throw new Error(`${PROJECT_FILE} not found for project: ${slug}`)
	let raw: unknown
	try {
		raw = JSON.parse(decode(await data.readFile(path)))
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
// declares). devkit reads it straight off the caller's own data dir (chrooted to
// `/data/<appId>`), so the source never crosses the worker boundary. The project
// file and the (potentially large) icon are skipped — they aren't source, and
// reading the icon on every live rebuild would tax the loop.
async function projectFiles(
	fs: Volume,
	appId: string,
	slug: string,
	manifest: AppManifest
): Promise<Record<string, string>> {
	const data = chroot(fs, `/data/${appId}`)
	const root = `/projects/${slug}`
	const skip = new Set([PROJECT_FILE, manifest.icon].filter((name): name is string => !!name))
	const files: Record<string, string> = {}
	if (await data.exists(root)) {
		await data.scan(root, async (path, stat) => {
			if (stat.type === FileType.Directory || stat.type === FileType.Symlink) return
			const rel = path.slice(root.length + 1)
			if (!skip.has(rel)) files[rel] = decode(await data.readFile(path))
		})
	}
	return files
}

// The project's declared icon (an image data URL), or undefined when unset/absent.
async function projectIcon(
	fs: Volume,
	appId: string,
	slug: string,
	iconPath?: string
): Promise<string | undefined> {
	if (!iconPath) return undefined
	const data = chroot(fs, `/data/${appId}`)
	const path = `/projects/${slug}/${iconPath}`
	return (await data.exists(path)) ? decode(await data.readFile(path)) : undefined
}

// The bundle's icon is the project's image data URL, stored verbatim as a single
// self-describing file (`manifest.icon` points at it). The launcher reads it
// straight off the volume — no separate mime metadata needed. Omitted entirely
// when the project has no icon.
const ICON_FILE = 'icon'
function iconBundle(icon?: string): { icon?: string; assets?: Record<string, string> } {
	return icon ? { icon: ICON_FILE, assets: { [ICON_FILE]: icon } } : {}
}
function iconManifest(icon?: string): { icon?: string } {
	return icon ? { icon: ICON_FILE } : {}
}

// Compile for shipping: unlike `run`, a bad build can't ship, so surface the
// diagnostics as a thrown error the gui shows instead of mounting a preview.
async function compiled(
	files: Record<string, string>,
	entries: CompileEntries
): Promise<{ app: string; gui: string }> {
	const { build, runtime } = await getToolchain()
	const { app, gui, diagnostics } = await compile(files, entries, build, runtime)
	if (diagnostics.length > 0) throw new Error(`Build failed:\n${diagnostics.join('\n')}`)
	if (!app || !gui) throw new Error('Build produced no output (need an app + gui entry).')
	return { app, gui }
}

// Mirror the preview stage's live menu into a display-only structure. The
// `onSelect` closures stay here on the main thread — only titles/state cross
// the boundary, so the app draws the real declared menus itself.
function menu({ previewId }: { previewId: string }): MenuView {
	const menus = host.menuOf(previewId)
	if (!menus) return []
	return menus.map((group) => ({
		title: group.title,
		items: group.items.map((item) =>
			'separator' in item
				? { separator: true }
				: {
						title: item.title,
						disabled: item.disabled,
						checked: item.checked,
						shortcut: item.shortcut
					}
		)
	}))
}

// Fire a preview menu item by position by invoking its real closure here on the
// main thread — the action runs against the live preview's typed client, no
// serialized callback required.
function selectMenu({
	previewId,
	menu: menuIndex,
	item: itemIndex
}: {
	previewId: string
	menu: number
	item: number
}): void {
	const entry = host.menuOf(previewId)?.[menuIndex]?.items?.[itemIndex]
	if (entry && !('separator' in entry) && !entry.disabled) entry.onSelect()
}

function runInput(input: unknown): RunInput {
	const value = input as { slug?: unknown; reset?: unknown }
	if (
		typeof value?.slug !== 'string' ||
		(value.reset !== undefined && typeof value.reset !== 'boolean')
	) {
		throw new CapabilityError('CAPABILITY_INVALID_INPUT', 'devkit', 'run')
	}
	return { slug: value.slug, reset: value.reset }
}

function slugInput(input: unknown, method: string): { slug: string } {
	const value = input as { slug?: unknown }
	if (typeof value?.slug !== 'string') {
		throw new CapabilityError('CAPABILITY_INVALID_INPUT', 'devkit', method)
	}
	return { slug: value.slug }
}

function stopInput(input: unknown): { previewId: string } {
	const value = input as { previewId?: unknown }
	if (typeof value?.previewId !== 'string') {
		throw new CapabilityError('CAPABILITY_INVALID_INPUT', 'devkit', 'stop')
	}
	return { previewId: value.previewId }
}

function menuInput(input: unknown): { previewId: string } {
	const value = input as { previewId?: unknown }
	if (typeof value?.previewId !== 'string') {
		throw new CapabilityError('CAPABILITY_INVALID_INPUT', 'devkit', 'menu')
	}
	return { previewId: value.previewId }
}

function selectMenuInput(input: unknown): { previewId: string; menu: number; item: number } {
	const value = input as { previewId?: unknown; menu?: unknown; item?: unknown }
	if (
		typeof value?.previewId !== 'string' ||
		typeof value.menu !== 'number' ||
		typeof value.item !== 'number'
	) {
		throw new CapabilityError('CAPABILITY_INVALID_INPUT', 'devkit', 'selectMenu')
	}
	return { previewId: value.previewId, menu: value.menu, item: value.item }
}
