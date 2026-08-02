import { ensureAgentDefaults } from '@justfiles/agent/defaults'
import { type Kernel, sweepTrash } from '@justfiles/app'
import type { Store } from '@justfiles/state'
import { UPDATE_CHECK_INTERVAL_MS } from '../../shared/appstore'
import { resetCapabilitySocket } from '../apps/capabilities.client'
import * as appHost from '../apps/host'
import { hydrateInstalledAppBundles } from '../apps/hydrate'
import { resumePendingInstalls } from '../apps/manage'
import { reconcileInstalled, seedBuiltins } from '../apps/seed'
import { activeProfileHasRemoteUser, flushActiveVolume, type ProfileVolume } from '../fs'
import { notificationStore } from '../notifications/store'
import type { FrierenClient } from './client'
import type { OsAction, OsState } from './state'
import { bootOsStore } from './store'

export interface OsRuntimeEnv {
	store: Store<OsState, OsAction>
	client: FrierenClient
	// Flush pending debounced persistence (page hide / provider unmount).
	flushPersist: () => void
	// The active profile volume; `flush()` gates the synced seed on bootstrap.
	volume: Promise<ProfileVolume>
	localKernel: () => Promise<Kernel>
}

// Wire the OS store to the client, app host, volume, and browser lifecycle.
// Everything here is boot-once/unmount-once orchestration — not reactive to
// React state — so it lives outside the component tree and the Provider drives
// it from a single effect. Returns a disposer that unwinds every subscription.
export function startOsRuntime(env: OsRuntimeEnv): () => void {
	const { store, client, flushPersist, volume, localKernel } = env
	const disposers: (() => void)[] = []

	// --- boot: hydrate persisted OS state; the reducer lifts the loading gate ---
	void bootOsStore(store, volume)

	// --- boot: materialise built-in apps ---
	let seedCancelled = false
	void (async () => {
		const fs = await volume
		// The client is the sole materialiser of built-in apps. A synced profile waits
		// for the first bootstrap before deciding, so an account that already has apps
		// isn't re-seeded; a local-only profile seeds immediately.
		const synced = activeProfileHasRemoteUser()
		await seedBuiltins(await localKernel(), fs, {
			waitForBootstrap: synced ? () => fs.flush() : undefined
		})
		// Local-only profiles have no server to seed the agent's identity files, so
		// give them the same default soul + empty profile the server writes for
		// synced ones. Idempotent, so it never clobbers a personalized soul.
		if (!synced) await ensureAgentDefaults(fs)
		if (!seedCancelled) client.refresh()
	})().catch(() => {})
	disposers.push(() => {
		seedCancelled = true
	})

	// --- boot: resume installs a previous session left pending (fs markers) ---
	// Fire-and-forget: the tiles reappear immediately (seeded from the markers) and
	// the downloads restart in the background, exactly like a fresh install.
	void (async () => {
		await resumePendingInstalls(await localKernel(), await volume, () => client.refresh())
	})().catch(() => {})

	// --- trash retention: purge uninstalled bundles past the retention window ---
	// Synced profiles are swept authoritatively server-side (the Frieren DO's daily
	// alarm), reliable regardless of an open tab; the deletes sync down. A local-only
	// (signed-out) profile has no server, so it sweeps its own trash here — cheap +
	// idempotent, on boot and a slow interval for long-lived tabs.
	if (!activeProfileHasRemoteUser()) {
		const sweep = () => void volume.then((fs) => sweepTrash(fs)).catch(() => {})
		sweep()
		const timer = setInterval(sweep, 12 * 60 * 60 * 1000)
		disposers.push(() => clearInterval(timer))
	}

	// app-code's `devkit.install` writes a new app straight to `/applications`
	// via its own kernel; re-list so it appears in the launcher right away.
	disposers.push(appHost.subscribeCatalog(() => client.refresh()))

	// The dock's catalog is a projection of the local volume's `/applications/*`.
	// Apps that arrive by sync-down land as REMOTE_SOURCE writes that no explicit
	// refresh covers, so re-list on the volume's structural change feed. The
	// recursive watch is structural-only (dirent create/remove/rename), so content
	// edits don't churn it; the client's setApps drops no-op re-lists.
	//
	// Scoped to `/applications` — the ONLY subtree either callback reads. A watch on `/`
	// made every unrelated write anywhere on the volume re-list the catalog AND re-run
	// the update pass: a bulk import (an Obsidian vault into Notes) fired both per
	// batch, each one two catalog fetches plus a stat of every file of every installed
	// app, over a tree that had not changed.
	{
		let off: (() => void) | undefined
		let cancelled = false
		// The same feed also makes app UPDATES prompt (a synced-down bundle drift
		// reconciles without waiting for the next boot). Monotonic + idempotent, so
		// coalesce overlapping bursts (one more if a change lands mid-run) rather than
		// stacking reconciles.
		let reconciling = false
		let again = false
		const reconcileNow = () => {
			if (cancelled) return
			if (reconciling) {
				again = true
				return
			}
			reconciling = true
			void (async () => reconcileInstalled(await localKernel(), await volume))()
				.catch(() => {})
				.finally(() => {
					reconciling = false
					if (again && !cancelled) {
						again = false
						reconcileNow()
					}
				})
		}
		void volume.then((fs) => {
			void fs
				.watch(
					// Not created yet on a first boot — seeding makes it. A recursive watch with
					// no root to resolve through matches on the path as spelled, so the seed's
					// own writes still arrive.
					'/applications',
					() => {
						client.refresh()
						reconcileNow()
					},
					{ recursive: true }
				)
				.then((unwatch) => {
					if (cancelled) unwatch()
					else off = unwatch
				})
		})
		// The periodic update checkpoint. The watch above only fires on local/synced
		// volume churn, so a tab left open for days would never notice a newly published
		// release; this is the one trigger that isn't reactive to the volume. Slow on
		// purpose (see UPDATE_CHECK_INTERVAL_MS) and coalesced through `reconcileNow`,
		// which also makes it the retry for an update that failed earlier.
		const checkpoint = setInterval(reconcileNow, UPDATE_CHECK_INTERVAL_MS)
		disposers.push(() => {
			cancelled = true
			clearInterval(checkpoint)
			off?.()
		})
	}

	// A host capability (devkit's live preview) frames its scoped stage as a
	// window by asking the shell to dispatch the matching window action.
	disposers.push(
		appHost.subscribeWindows((req) => {
			if (req.type === 'open') store.dispatch({ type: 'app.open', appId: req.id, title: req.title })
			else store.dispatch({ type: 'window.close', id: req.id })
		})
	)

	// --- prefetch installed app bundles, re-running as the catalog changes ---
	{
		let cancelled = false
		let running = false
		let pending = false
		const hydrate = () => {
			if (cancelled) return
			// Coalesce overlapping requests, but remember a catalog change that
			// arrived mid-run so a newly-installed app still gets prefetched.
			if (running) {
				pending = true
				return
			}
			running = true
			void hydrateInstalledAppBundles(localKernel)
				.catch(() => {})
				.finally(() => {
					running = false
					if (pending && !cancelled) {
						pending = false
						hydrate()
					}
				})
		}
		hydrate()
		const unsubscribe = client.subscribeApps(hydrate)
		disposers.push(() => {
			cancelled = true
			unsubscribe()
		})
	}

	// OS state is authoritative client-side shell state, so don't rely on
	// unload alone: prompt writes happen on commit, and this flushes any
	// pending geometry write before the tab goes away or the provider unmounts.
	{
		const onHidden = () => {
			if (document.visibilityState === 'hidden') flushPersist()
		}
		window.addEventListener('pagehide', flushPersist)
		document.addEventListener('visibilitychange', onHidden)
		disposers.push(() => {
			window.removeEventListener('pagehide', flushPersist)
			document.removeEventListener('visibilitychange', onHidden)
			flushPersist()
		})
	}

	// Server-echoed app open/close drive the OS store as remote actions. Wire
	// the handler before connecting so an early live open isn't missed. Queue
	// it until local OS state has booted; otherwise server opens briefly create
	// default-rect windows before the persisted rects load.
	{
		const pending: Parameters<typeof store.dispatch>[0][] = []
		const flushPending = () => {
			if (!store.getState().booted) return
			for (const action of pending.splice(0)) store.dispatch(action)
		}
		const unsubscribeRemote = client.onRemoteWindow((action) => {
			if (!store.getState().booted) {
				pending.push(action)
				return
			}
			store.dispatch(action)
		})
		// Agent / cron notification frames feed the one notification store (pill + center).
		const unsubscribeNotify = client.onNotification((notification) =>
			notificationStore.notify(notification)
		)
		// Server->client volume poke: any server-side write (agent, cron, another
		// device's push) flushes the active volume so the change lands at once.
		const unsubscribeSync = client.onSync(() => flushActiveVolume())
		const unsubscribeStore = store.subscribe(flushPending)
		disposers.push(() => {
			unsubscribeRemote()
			unsubscribeNotify()
			unsubscribeSync()
			unsubscribeStore()
			client.close()
			// A fresh session (sign-out / user switch) starts with an empty center.
			notificationStore.clear()
			// App GUI hosting is part of OS lifecycle: drop every stage so a
			// previous session's DOM doesn't survive sign-out / user switch.
			appHost.closeAll()
			// Drop the shared capability-proxy socket for the same reason.
			resetCapabilitySocket()
		})
	}

	let disposed = false
	return () => {
		if (disposed) return
		disposed = true
		// Unwind in reverse so teardown mirrors setup order.
		for (const off of disposers.reverse()) off()
	}
}
