/// <reference types="@justfiles/app/virtual" />
//
// Host-side wiring for client-only apps. The build-time virtual module
// (emitted by `hostApps()` in vite.config.ts; see @justfiles/app/vite) gives
// us per-app manifests — small data the worker bundles. The bytes for
// HTML/JS/CSS/wasm/wad ship via Workers Static Assets under
// `/apps/<id>/<path>` and are streamed through `c.env.ASSETS` by the
// `/apps/*` route in `index.ts`.

import { registry } from 'virtual:@justfiles/apps'
import type { AppPermission } from '@justfiles/app'
import sdkJs from '@justfiles/app/sdk?raw'

export const listAppIds = (): string[] => [...registry.keys()]
export const listApps = (): { id: string; name: string; description: string; iconUrl?: string }[] =>
	[...registry.entries()].map(([id, entry]) => ({
		id,
		name: entry.manifest.name,
		description: entry.manifest.description,
		iconUrl: entry.manifest.icon ? `/apps/${id}/${entry.manifest.icon}` : undefined
	}))
export const hasApp = (id: string): boolean => registry.has(id)
export const getEntryPath = (id: string): string | undefined => registry.get(id)?.manifest.entry
// Manifest-declared permissions for an app. Default-deny — an unknown id
// or a manifest without the field returns an empty list, which the RPC
// dispatcher gates volume calls against.
export const getAppPermissions = (id: string): readonly AppPermission[] =>
	registry.get(id)?.manifest.permissions ?? []
export const SDK_JS = sdkJs
