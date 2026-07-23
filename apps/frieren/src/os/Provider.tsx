import { useAuth, useUser } from '@clerk/clerk-react'
import type { UserProfile } from '@justfiles/app/capabilities/user'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { resetCapabilitySocket } from '../apps/capabilities.client'
import * as appHost from '../apps/host'
import { createClientKernel } from '../apps/kernel.client'
import type { InstalledApp } from '../apps/types'
import { openProfile } from '../fs'
import { createFrierenClient } from './client'
import { OsContext } from './hooks'
import { startOsRuntime } from './runtime'
import { createOsStore } from './store'

// Clerk serves avatars from img.clerk.com. An app renders the signed-in user's
// avatar through the `user` capability, but the app frame's CSP is network-deny
// (`img-src data: blob:`), so a remote `<img src>` is blocked. Convert the avatar
// to a `data:` URL on the host (which has network) so the frame can render it with
// no remote fetch — the capability-mediated pattern the sandbox plan calls for.
// Sized down + cached by source URL to stay small in the app's synced state; any
// failure (e.g. no CORS) drops the avatar and the app shows its placeholder. Host
// chrome (banner/omnibar) is unaffected — it isn't inside a CSP'd frame.
const avatarCache = new Map<string, Promise<string | undefined>>()
function avatarDataUrl(imageUrl: string): Promise<string | undefined> {
	let cached = avatarCache.get(imageUrl)
	if (!cached) {
		cached = (async () => {
			try {
				const url = new URL(imageUrl)
				url.searchParams.set('width', '80')
				url.searchParams.set('height', '80')
				url.searchParams.set('fit', 'crop')
				const res = await fetch(url, { credentials: 'omit' })
				if (!res.ok) return undefined
				const blob = await res.blob()
				return await new Promise<string | undefined>((resolve) => {
					const reader = new FileReader()
					reader.onload = () =>
						resolve(typeof reader.result === 'string' ? reader.result : undefined)
					reader.onerror = () => resolve(undefined)
					reader.readAsDataURL(blob)
				})
			} catch {
				return undefined
			}
		})()
		avatarCache.set(imageUrl, cached)
	}
	return cached
}

const ICON_MIME: Record<string, string> = {
	png: 'image/png',
	svg: 'image/svg+xml',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	webp: 'image/webp',
	gif: 'image/gif',
	ico: 'image/x-icon'
}

// Resolve an installed app's icon to a stable data URL read from its bundle in the
// volume — works for built-ins, community apps, and devkit drafts alike (the old
// static `/appstore/...` path only existed for built-ins, so community icons 404'd
// to the SPA fallback). A devkit draft stores its icon AS a data URL, so that's
// passed through. Data URLs (not blob: URLs) keep the value stable across refreshes
// so the client's app-list dedup doesn't churn.
function iconDataUrl(path: string, bytes: Uint8Array): string {
	if (new TextDecoder().decode(bytes.subarray(0, 5)) === 'data:')
		return new TextDecoder().decode(bytes)
	const mime = ICON_MIME[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream'
	let binary = ''
	for (let i = 0; i < bytes.length; i += 0x8000)
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
	return `data:${mime};base64,${btoa(binary)}`
}

export function OSProvider({ children }: { children: ReactNode }) {
	const { getToken, isLoaded, isSignedIn, userId } = useAuth()
	const getTokenRef = useRef(getToken)
	getTokenRef.current = getToken

	// The signed-in user for the local `user` capability. Held in a ref (like
	// getToken) so the kernel — created once — always reads the CURRENT Clerk session.
	const { user, isLoaded: userLoaded } = useUser()
	const getUserRef = useRef<() => UserProfile | null>(() => null)
	getUserRef.current = () =>
		user
			? { id: user.id, name: user.fullName ?? user.username ?? undefined, avatarUrl: user.imageUrl }
			: null

	// frieren boots the OS before Clerk resolves (local-first), so a resumed window's
	// first capability calls can race auth: `getToken`/`getUser` would return null and
	// the app would latch a signed-out view (Settings showing "Local user", a socket
	// CAPABILITY_UNAVAILABLE). Gate both on Clerk being loaded so those reads WAIT for
	// the resolved session instead of capturing a null. Signed-out then resolves to a
	// real null (not a race), which is correct.
	const clerkReadyRef = useRef<{ promise: Promise<void>; resolve: () => void } | null>(null)
	if (!clerkReadyRef.current) {
		let resolve!: () => void
		const promise = new Promise<void>((r) => {
			resolve = r
		})
		clerkReadyRef.current = { promise, resolve }
	}
	useEffect(() => {
		if (isLoaded && userLoaded) clerkReadyRef.current?.resolve()
	}, [isLoaded, userLoaded])
	const readyGetToken = async (): Promise<string | null> => {
		await clerkReadyRef.current?.promise
		return getTokenRef.current()
	}
	const readyGetUser = async (): Promise<UserProfile | null> => {
		await clerkReadyRef.current?.promise
		const profile = getUserRef.current()
		// Hand apps a data: URL avatar (CSP-renderable inside the sandboxed frame),
		// not the remote img.clerk.com URL their frame can't fetch.
		if (!profile?.avatarUrl) return profile
		return { ...profile, avatarUrl: await avatarDataUrl(profile.avatarUrl) }
	}

	// The current profile volume is opened at boot (App); the singleton hands back
	// the same replica. getToken is only needed by network capabilities.
	const [volumePromise] = useState(() => openProfile())
	const [localKernel] = useState(() => {
		let kernelPromise: Promise<ReturnType<typeof createClientKernel>> | undefined
		return () =>
			(kernelPromise ??= volumePromise.then((fs) =>
				createClientKernel({ fs, getToken: readyGetToken, getUser: readyGetUser })
			))
	})
	const [client] = useState(() =>
		createFrierenClient({
			getToken: readyGetToken,
			listLocalApps: async (): Promise<InstalledApp[]> => {
				const kernel = await localKernel()
				return Promise.all(
					(await kernel.list()).map(async (m) => {
						let iconUrl: string | undefined
						if (m.icon) {
							try {
								iconUrl = iconDataUrl(m.icon, await (await kernel.app(m.id)).read(m.icon))
							} catch {}
						}
						return {
							id: m.id,
							name: m.name,
							description: m.description ?? '',
							version: m.version,
							iconUrl,
							capabilities: m.capabilities
						}
					})
				)
			}
		})
	)
	const [{ store, flushPersist }] = useState(() =>
		createOsStore({
			appHost,
			send: client.send,
			volume: volumePromise,
			localKernel
		})
	)

	// All boot/subscription wiring is mount-once (its deps are stable singletons),
	// so it lives in the runtime rather than a fan of effects. Only the auth effect
	// below is genuinely reactive to Clerk state.
	useEffect(
		() => startOsRuntime({ store, client, flushPersist, volume: volumePromise, localKernel }),
		[store, client, flushPersist, volumePromise, localKernel]
	)

	// biome-ignore lint/correctness/useExhaustiveDependencies: backend sockets must reconnect when Clerk's session changes.
	useEffect(() => {
		// Auth is optional. Before/without a signed-in session, keep backend sockets
		// closed and let the client replay the local catalog.
		resetCapabilitySocket()
		if (!isLoaded || !isSignedIn) {
			client.close()
			return
		}
		client.connect()
		return () => {
			client.close()
			resetCapabilitySocket()
		}
	}, [client, isLoaded, isSignedIn, userId])

	const value = useMemo(
		() => ({ store, client, localKernel, volume: volumePromise }),
		[store, client, localKernel, volumePromise]
	)

	return <OsContext.Provider value={value}>{children}</OsContext.Provider>
}
