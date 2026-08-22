import type { Kernel } from '@justfiles/app/runtime'
import { REMOTE_SOURCE, type Volume } from '@justfiles/fs'
import { coalesce } from './coalesce'

interface RefreshOptions {
	volume: Promise<Volume>
	kernel: Promise<Kernel>
	publishState(appId: string, state: unknown): void
	reloadApp(appId: string): void
	refreshApplications(): Promise<void>
}

interface AppWatch {
	refs: number
	closed: boolean
	manifest: string | null
	off: (() => void)[]
	ready: Promise<void>
	stateChanged(): void
	bundleChanged(): void
}

export interface RuntimeRefresh {
	openApp(appId: string): Promise<void>
	closeApp(appId: string): void
	refreshApps(): void
	close(): Promise<void>
}

export function runtimeRefresh(options: RefreshOptions): RuntimeRefresh {
	const jobs = new Set<Promise<unknown>>()
	const off = new Set<() => void>()
	const apps = new Map<string, AppWatch>()
	// Watches stop with the last socket. Keep the manifest so reopen can find changes from the gap.
	const manifests = new Map<string, string | null>()
	let closed = false

	const run = <T>(work: () => Promise<T>): Promise<T | undefined> => {
		if (closed) return Promise.resolve(undefined)
		const job = work()
		jobs.add(job)
		void job.then(
			() => jobs.delete(job),
			() => jobs.delete(job)
		)
		return job
	}
	const report = (error: unknown): void => console.warn('runtime refresh:', error)
	const refreshApplications = coalesce(() =>
		run(options.refreshApplications).then(
			() => undefined,
			(error) => report(error)
		)
	)

	void run(async () => {
		const [fs, kernel] = await Promise.all([options.volume, options.kernel])
		if (closed) return
		const unwatch = await fs.watch(
			'/applications',
			(event) => {
				if (event.source === REMOTE_SOURCE) refreshApplications()
			},
			{ recursive: true }
		)
		if (closed) unwatch()
		else off.add(unwatch)

		const unsubscribe = kernel.subscribe((event) => {
			if (closed) return
			if (event.type === 'app.update') options.publishState(event.appId, event.state)
			else if (event.type === 'app.installed' || event.type === 'app.uninstalled')
				refreshApplications()
		})
		if (closed) unsubscribe()
		else off.add(unsubscribe)
	}).catch(report)

	function openApp(appId: string): Promise<void> {
		const held = apps.get(appId)
		if (held) {
			held.refs++
			return held.ready
		}

		let entry: AppWatch
		const stateChanged = coalesce(() =>
			run(async () => {
				const kernel = await options.kernel
				await kernel.reload(appId)
				const state = await kernel.state(appId)
				if (!entry.closed && !closed) options.publishState(appId, state)
			}).then(
				() => undefined,
				(error) => report(error)
			)
		)
		const bundleChanged = coalesce(() =>
			run(async () => {
				const next = await readManifest(await options.volume, appId)
				if (entry.closed || closed || next === entry.manifest) return
				await (await options.kernel).reloadBundle(appId)
				if (entry.closed || closed) return
				entry.manifest = next
				manifests.set(appId, next)
				options.reloadApp(appId)
			}).then(
				() => undefined,
				(error) => report(error)
			)
		)

		entry = {
			refs: 1,
			closed: false,
			manifest: null,
			off: [],
			ready: Promise.resolve(),
			stateChanged,
			bundleChanged
		}
		apps.set(appId, entry)
		entry.ready = run(async () => {
			const fs = await options.volume
			const saved = manifests.get(appId)
			if (saved === undefined) {
				entry.manifest = await readManifest(fs, appId)
				manifests.set(appId, entry.manifest)
			} else entry.manifest = saved
			const watches = await Promise.all([
				fs.watch(`/state/${appId}.json`, (event) => {
					if (event.source === REMOTE_SOURCE && !entry.closed) entry.stateChanged()
				}),
				fs.watch(`/applications/${appId}/manifest.json`, (event) => {
					if (event.source === REMOTE_SOURCE && !entry.closed) entry.bundleChanged()
				})
			])
			if (entry.closed || closed) for (const unwatch of watches) unwatch()
			else entry.off.push(...watches)

			const current = await readManifest(fs, appId)
			if (current !== entry.manifest) entry.bundleChanged()
		}).then(
			() => undefined,
			(error) => report(error)
		)
		return entry.ready
	}

	function closeApp(appId: string): void {
		const entry = apps.get(appId)
		if (!entry || --entry.refs > 0) return
		entry.closed = true
		for (const unwatch of entry.off.splice(0)) unwatch()
		apps.delete(appId)
	}

	return {
		openApp,
		closeApp,
		refreshApps: refreshApplications,
		async close() {
			if (closed) return
			closed = true
			for (const entry of apps.values()) {
				entry.closed = true
				for (const unwatch of entry.off) unwatch()
			}
			apps.clear()
			for (const stop of off) stop()
			off.clear()
			while (jobs.size > 0) await Promise.allSettled([...jobs])
		}
	}
}

async function readManifest(fs: Volume, appId: string): Promise<string | null> {
	try {
		return new TextDecoder().decode(await fs.readFile(`/applications/${appId}/manifest.json`))
	} catch {
		return null
	}
}
