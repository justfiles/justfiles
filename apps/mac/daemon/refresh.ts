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
	manifest: string | null | undefined
	off: (() => void)[]
	ready: Promise<void>
	stateChanged(): Promise<void>
	bundleChanged(): Promise<void>
	stop(): void
}

export interface RuntimeRefresh {
	openApp(appId: string): Promise<void>
	closeApp(appId: string): void
	refreshApps(): Promise<void>
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
	const applications = retry(
		() => run(options.refreshApplications).then(() => undefined),
		() => closed,
		report
	)
	const refreshApplications = applications.run

	void run(async () => {
		const [fs, kernel] = await Promise.all([options.volume, options.kernel])
		if (closed) return
		const unwatch = await fs.watch(
			'/applications',
			(event) => {
				if (event.source === REMOTE_SOURCE) void refreshApplications()
			},
			{ recursive: true }
		)
		if (closed) unwatch()
		else off.add(unwatch)

		const unsubscribe = kernel.subscribe((event) => {
			if (closed) return
			if (event.type === 'app.update') options.publishState(event.appId, event.state)
			else if (event.type === 'app.installed' || event.type === 'app.uninstalled')
				void refreshApplications()
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
		const state = retry(
			() =>
				run(async () => {
					const kernel = await options.kernel
					await kernel.reload(appId)
					const state = await kernel.state(appId)
					if (!entry.closed && !closed) options.publishState(appId, state)
				}).then(() => undefined),
			() => entry.closed || closed,
			report
		)
		const bundle = retry(
			() =>
				run(async () => {
					const next = await readManifest(await options.volume, appId)
					if (entry.closed || closed) return
					if (entry.manifest === undefined) {
						entry.manifest = next
						manifests.set(appId, next)
						return
					}
					if (next === entry.manifest) return
					await (await options.kernel).reloadBundle(appId)
					if (entry.closed || closed) return
					entry.manifest = next
					manifests.set(appId, next)
					options.reloadApp(appId)
				}).then(() => undefined),
			() => entry.closed || closed,
			report
		)

		entry = {
			refs: 1,
			closed: false,
			manifest: manifests.get(appId),
			off: [],
			ready: Promise.resolve(),
			stateChanged: state.run,
			bundleChanged: bundle.run,
			stop() {
				state.stop()
				bundle.stop()
			}
		}
		apps.set(appId, entry)
		entry.ready = run(async () => {
			const fs = await options.volume
			const watches = await Promise.all([
				fs.watch(`/state/${appId}.json`, (event) => {
					if (event.source === REMOTE_SOURCE && !entry.closed) void entry.stateChanged()
				}),
				fs.watch(`/applications/${appId}/manifest.json`, (event) => {
					if (event.source === REMOTE_SOURCE && !entry.closed) void entry.bundleChanged()
				})
			])
			if (entry.closed || closed) for (const unwatch of watches) unwatch()
			else entry.off.push(...watches)
			await entry.bundleChanged()
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
		entry.stop()
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
			applications.stop()
			for (const entry of apps.values()) {
				entry.closed = true
				entry.stop()
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
	const path = `/applications/${appId}/manifest.json`
	try {
		return new TextDecoder().decode(await fs.readFile(path))
	} catch (error) {
		if (error instanceof Error && error.message === `ENOENT: ${path}`) return null
		throw error
	}
}

function retry(
	work: () => Promise<void>,
	stopped: () => boolean,
	report: (error: unknown) => void
): { run(): Promise<void>; stop(): void } {
	let timer: ReturnType<typeof setTimeout> | undefined
	const stop = (): void => {
		clearTimeout(timer)
		timer = undefined
	}
	const run = coalesce(async () => {
		try {
			await work()
			stop()
		} catch (error) {
			report(error)
			if (stopped() || timer !== undefined) return
			timer = setTimeout(() => {
				timer = undefined
				void run()
			}, 5_000)
		}
	})
	return { run, stop }
}
