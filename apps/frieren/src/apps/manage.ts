import { bundleFromZip, type Kernel } from '@justfiles/app'
import { installApp } from '@justfiles/app/appstore'
import type { Volume } from '@justfiles/fs'
import { httpAppStore, runnerAppStore } from '../../shared/appstore'
import { endInstall, readInstallMarkers, seedInstalling } from './installing'

export async function installZipApp(kernel: Kernel, zip: Uint8Array): Promise<string> {
	return kernel.install(bundleFromZip(zip))
}

// Resolve Runner's current manifest pointer, then persist its canonical manifest
// and reducer. Mounted files remain on the immutable Runner release URL.
export async function installRunnerApp(kernel: Kernel, id: string): Promise<void> {
	const store = await runnerAppStore()
	if (!store) throw new Error('app store unavailable')
	const app = await store.latest(id)
	if (!app) throw new Error(`not in app store: ${id}`)
	await installApp(kernel, store, app)
}

// Built-in apps are guarded from uninstall (conservative for now); user apps
// uninstall normally.
export async function uninstallLocalApp(kernel: Kernel, id: string): Promise<void> {
	if (await isBuiltin(id)) throw new Error(`built-in apps cannot be uninstalled: ${id}`)
	await kernel.uninstall(id)
}

async function isBuiltin(id: string): Promise<boolean> {
	try {
		const store = await httpAppStore((path) => fetch(path))
		if (store) return (await store.builtins()).some((app) => app.id === id)
	} catch {}
	return id.startsWith('app.justfiles.frieren.')
}

// Restart installs left pending by a closed/crashed tab (the fs markers under
// `/.state/installing`). Seeds the launcher tiles up front, then for each marker
// either clears it (the app actually landed before the crash) or re-runs the
// install. Restart, not byte-level resume — `installApp` is atomic + idempotent,
// so re-downloading is safe; `finally` clears the marker so a permanently-failing
// intent can't get stuck retrying every boot.
export async function resumePendingInstalls(
	kernel: Kernel,
	fs: Volume,
	onChange: () => void
): Promise<void> {
	const markers = await readInstallMarkers(fs)
	if (markers.length === 0) return
	seedInstalling(markers)
	const installed = new Set((await kernel.list()).map((m) => m.id))
	for (const marker of markers) {
		if (installed.has(marker.id)) {
			await endInstall(fs, marker.id)
			continue
		}
		try {
			await installRunnerApp(kernel, marker.id)
		} catch {
		} finally {
			await endInstall(fs, marker.id)
		}
	}
	onChange()
}
