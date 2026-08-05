// The devkit build pipeline: read a draft's project off a data volume and
// build / install / pack it. The heavy compute is the swappable `Toolchain`
// (`@justfiles/app/toolchain/*`); this module is the generic host layer around it —
// project I/O (read the tree, write `/applications`, zip) and the diagnostics →
// string adaptation `buildDraft` produces for the preview/ship path. Host-agnostic
// and browser-safe: the esbuild/typescript toolchains are injected, never imported
// here.
//
// A devkit project is a directory in a caller's data volume: a `project.json`
// build contract (an `AppManifest` whose entry paths point at the `src/*`
// sources) plus the source tree and an optional icon file. Callers name the
// project by `slug`; the pipeline reads the tree off the supplied volume.

import { chroot, type Volume } from '@justfiles/fs'
import { FileType } from '@justfiles/fs/types'
import { strToU8, zipSync } from 'fflate'
import type { TsConfigJson } from 'type-fest'
import { type AppManifest, appBundleFromMemory, type Kernel, safeBundlePath } from '../../kernel.ts'
import type { ProjectInput, Toolchain } from './toolchain.ts'

const PROJECT_FILE = 'project.json'

// A compiled draft: its identity (from `project.json`), the two compiled entries
// (empty on failure), the optional icon data URL, and any compile diagnostics.
export interface DraftBuild {
	manifest: AppManifest
	app: string
	gui: string
	icon?: string
	diagnostics: string[]
}

// The standard tsconfig generated from a manifest — the one home for our
// conventions (strict, bundler resolution, noEmit). `tsc`/`tsgo`
// consume it whole; esbuild's resolution is plugin-driven, so it ignores this.
// type-fest's `TsConfigJson` is the zero-runtime schema — don't hand-roll it.
export function tsconfigFor(manifest: AppManifest): TsConfigJson {
	return {
		compilerOptions: {
			target: 'es2022',
			lib: ['es2022', 'dom', 'dom.iterable'],
			module: 'esnext',
			moduleResolution: 'bundler',
			strict: true,
			esModuleInterop: true,
			skipLibCheck: true,
			noEmit: true,
			types: []
		},
		include: [manifest.app, ...(manifest.gui ? [manifest.gui] : [])]
	}
}

// Read the named project off `data` and shape it as the toolchain's `ProjectInput`
// (vfs map + named entries + generated tsconfig) — the shared front half of every
// toolchain method. Exported so the devkit host factory's `compile`/`typecheck` can
// feed a `Toolchain` directly. Only `readProjectFile` can throw (missing/invalid
// project.json).
export async function readProject(
	data: Volume,
	slug: string
): Promise<{ manifest: AppManifest; input: ProjectInput }> {
	const manifest = await readProjectFile(data, slug)
	const files = await projectFiles(data, slug, manifest)
	const entries: Record<string, string> = {
		app: manifest.app,
		...(manifest.gui ? { gui: manifest.gui } : {})
	}
	return { manifest, input: { files, entries, tsconfig: tsconfigFor(manifest) } }
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
	const { manifest, input } = await readProject(data, slug)
	// Adapt the structured compile result to the preview/ship shape: pick the two
	// conventional named bundles, flatten error diagnostics to strings (warnings
	// stay off this surface; the Problems panel reads the full set via `compile`).
	const { outputs, diagnostics } = await tc.compile(input)
	const text = (name: string) => outputs.find((output) => output.path === `${name}.js`)?.text ?? ''
	const messages = diagnostics
		.filter((diagnostic) => diagnostic.severity === 'error')
		.map((diagnostic) =>
			diagnostic.file
				? `${diagnostic.message} (${diagnostic.file}:${diagnostic.range.start.line + 1})`
				: diagnostic.message
		)
	const icon = await projectIcon(data, slug, manifest.icon)
	return { manifest, app: text('app'), gui: text('gui'), icon, diagnostics: messages }
}

// Compile + promote the project to the REAL `/applications` via the host's
// `kernel`. By default install only ever creates — re-shipping an existing id is
// rejected (guarded check-first on the live catalog). `opts.overwrite` lifts the
// guard so a re-install updates the live app in place (the store backs up and
// atomically replaces the bundle; the kernel re-warms its streams). The
// project's icon, if any, is bundled. Identity comes from the project file, so
// the installed id is the author's. Any post-install host work (re-list a
// catalog, re-materialise an OS bundle) is sequenced by the caller after this
// resolves — it's privileged host code, off the guest's call path.
export async function installDraft(
	fs: Volume,
	appId: string,
	slug: string,
	kernel: Kernel,
	tc: Toolchain,
	opts?: { overwrite?: boolean }
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
