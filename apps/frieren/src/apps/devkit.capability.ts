import { appBundleFromMemory } from '@justfiles/app'
import { CapabilityError } from '@justfiles/app/capabilities'
import type { MenuView } from '@justfiles/app/capabilities/devkit'
import {
	buildDraft,
	compileDraft,
	installDraft,
	packDraft,
	type Toolchain
} from '@justfiles/app/devkit'
import { esbuildEngine } from '@justfiles/app/engine/esbuild'
import { chroot, type Volume } from '@justfiles/fs'
import * as host from './host'
import { createClientKernel } from './kernel.client'

// Local, main-thread `devkit` capability impl. The generic build pipeline —
// compile, buildDraft / installDraft / packDraft, project I/O — lives in
// `@justfiles/app/devkit`; this impl supplies the browser `Toolchain`
// (esbuild-wasm + the system runtime virtual module) and owns the one thing that
// can't be shared: mounting the live preview into the caller's own
// `[data-preview-slot]`, same document, same thread. The caller only ever names
// the project (`slug`); the pipeline reads its `project.json` + source tree
// straight off the caller's data dir, so files never cross the worker boundary —
// the reducer only exchanges a slug, ids, diagnostics and zip bytes. Routed only
// for allowlisted apps (see capabilities.client / devkit.allowlist).

type GetToken = () => Promise<string | null>
type RunInput = { slug: string; reset?: boolean }

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
	req: { method: string; args: readonly unknown[]; appId: string }
): Promise<unknown> {
	const input = req.args[0]
	switch (req.method) {
		case 'run':
			return run(fs, getToken, req.appId, runInput(input))
		case 'stop':
			return stop(stopInput(input))
		case 'menu':
			return menu(menuInput(input))
		case 'selectMenu':
			return selectMenu(selectMenuInput(input))
		case 'compile':
			return compile(fs, req.appId, slugInput(input, 'compile'))
		case 'typecheck':
			// Browser host: no type checker (the 8 MB dep stays off the client).
			// Online, frieren routes typecheck to its container (engine doc §5).
			throw new CapabilityError('CAPABILITY_UNAVAILABLE', 'devkit', 'typecheck')
		case 'install':
			return install(fs, getToken, req.appId, slugInput(input, 'install'))
		case 'pack':
			return pack(fs, req.appId, slugInput(input, 'pack'))
		default:
			throw new CapabilityError('CAPABILITY_UNAVAILABLE', 'devkit', req.method)
	}
}

// Bundle the named project with the browser esbuild engine, returning the
// structured `CompileResult` (outputs + diagnostics) for app-code's Problems
// panel. No mount — that's `run`.
async function compile(fs: Volume, appId: string, { slug }: { slug: string }) {
	return compileDraft(chroot(fs, `/data/${appId}`), slug, esbuildEngine(await getToolchain()))
}

async function run(
	fs: Volume,
	getToken: GetToken,
	appId: string,
	{ slug, reset }: RunInput
): Promise<{ previewId: string; diagnostics: string[] }> {
	const previewId = `preview.${slug}`
	const { manifest, app, gui, diagnostics } = await buildDraft(
		chroot(fs, `/data/${appId}`),
		slug,
		await getToolchain()
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
// `notifyCatalog` wakes the launcher to re-list.
async function install(
	fs: Volume,
	getToken: GetToken,
	appId: string,
	{ slug }: { slug: string }
): Promise<{ id: string }> {
	const kernel = createClientKernel({ fs, getToken })
	return installDraft(fs, appId, slug, kernel, await getToolchain(), {
		onInstalled: () => host.notifyCatalog()
	})
}

// Compile + emit a downloadable `.zip` of the bundle.
async function pack(
	fs: Volume,
	appId: string,
	{ slug }: { slug: string }
): Promise<{ zip: Uint8Array }> {
	return packDraft(chroot(fs, `/data/${appId}`), slug, await getToolchain())
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
