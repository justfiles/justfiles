import type { AppManifest, Kernel } from '@justfiles/app/runtime'
import { REMOTE_SOURCE, type Volume } from '@justfiles/fs'
import { coalesce } from './coalesce'

interface RefreshOptions {
	volume: Promise<Volume>
	kernel: Promise<Kernel>
	publishState(appId: string, state: unknown): void
	reloadApp(appId: string): void
	refreshApplications(apps: AppManifest[]): Promise<void>
}

interface AppWatch {
	refs: number
	off?: () => void
	ready: Promise<void>
	stateChanged(): Promise<void>
	stop(): void
}

interface BundleWatch {
	manifest: string | null | undefined
	off?: () => void
	ready: Promise<void>
	changed(): Promise<void>
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
	const bundles = new Map<string, BundleWatch>()
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
		() =>
			run(async () => {
				const installed = await (await options.kernel).list()
				if (closed) return
				await syncBundles(installed.map((app) => app.id))
				if (!closed) await options.refreshApplications(installed)
			}).then(() => undefined),
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

	function watchBundle(appId: string): BundleWatch {
		const held = bundles.get(appId)
		if (held) return held

		let entry: BundleWatch
		const changed = retry(
			() =>
				run(async () => {
					const before = entry.manifest
					const next = await readManifest(await options.volume, appId)
					if (closed || bundles.get(appId) !== entry || (before !== undefined && next === before))
						return
					await (await options.kernel).reloadBundle(appId)
					if (closed || bundles.get(appId) !== entry) return
					entry.manifest = next
					if (before !== undefined && apps.has(appId)) options.reloadApp(appId)
				}).then(() => undefined),
			() => closed || bundles.get(appId) !== entry,
			report
		)

		entry = {
			manifest: undefined,
			ready: Promise.resolve(),
			changed: changed.run,
			stop: changed.stop
		}
		bundles.set(appId, entry)
		entry.ready = run(async () => {
			const fs = await options.volume
			const unwatch = await fs.watch(`/applications/${appId}/manifest.json`, (event) => {
				if (event.source === REMOTE_SOURCE && bundles.get(appId) === entry) void entry.changed()
			})
			if (closed || bundles.get(appId) !== entry) unwatch()
			else entry.off = unwatch
			await entry.changed()
		}).then(
			() => undefined,
			(error) => report(error)
		)
		return entry
	}

	async function syncBundles(ids: string[]): Promise<void> {
		const keep = new Set(ids)
		const removed: Promise<unknown>[] = []
		for (const [appId, entry] of bundles) {
			if (keep.has(appId)) continue
			bundles.delete(appId)
			entry.stop()
			entry.off?.()
			removed.push(
				run(async () => {
					await (await options.kernel).reloadBundle(appId)
					if (!closed && apps.has(appId)) options.reloadApp(appId)
				})
			)
		}
		await Promise.all([...ids.map((id) => watchBundle(id).ready), ...removed])
	}

	async function openApp(appId: string): Promise<void> {
		const held = apps.get(appId)
		if (held) {
			held.refs++
			await Promise.all([held.ready, watchBundle(appId).changed()])
			await held.stateChanged()
			return
		}

		let entry: AppWatch
		const state = retry(
			() =>
				run(async () => {
					const kernel = await options.kernel
					const state = await kernel.state(appId)
					if (!closed && apps.get(appId) === entry) options.publishState(appId, state)
				}).then(() => undefined),
			() => closed || apps.get(appId) !== entry,
			report
		)
		entry = {
			refs: 1,
			ready: Promise.resolve(),
			stateChanged: state.run,
			stop: state.stop
		}
		apps.set(appId, entry)
		entry.ready = run(async () => {
			const fs = await options.volume
			const unwatch = await fs.watch(`/state/${appId}.json`, (event) => {
				if (event.source === REMOTE_SOURCE && apps.get(appId) === entry) void entry.stateChanged()
			})
			if (closed || apps.get(appId) !== entry) unwatch()
			else entry.off = unwatch
			await watchBundle(appId).changed()
		}).then(
			() => undefined,
			(error) => report(error)
		)
		await entry.ready
		await entry.stateChanged()
	}

	function closeApp(appId: string): void {
		const entry = apps.get(appId)
		if (!entry || --entry.refs > 0) return
		apps.delete(appId)
		entry.stop()
		entry.off?.()
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
				entry.stop()
				entry.off?.()
			}
			apps.clear()
			for (const entry of bundles.values()) {
				entry.stop()
				entry.off?.()
			}
			bundles.clear()
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
