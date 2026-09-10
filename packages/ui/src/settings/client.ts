import { BUILTIN_AVATARS } from '@justfiles/agent/avatars'
import { IDENTITY_DEFAULTS, IDENTITY_PATHS } from '@justfiles/agent/defaults'
import type { Volume } from '@justfiles/fs'
import { fileSettings } from './files.ts'
import type { GetUser } from './host.ts'
import { settingsClient } from './http.ts'
import { DOCK_MATERIAL_PATH, WALLPAPER_PATH } from './types.ts'

export interface SettingsOptions {
	getToken(): Promise<string | null>
	local?: { volume: Volume; user: GetUser; version: string }
}

// A save can outlive its window; keep the file write queue with the volume.
const volumes = new WeakMap<Volume, ReturnType<typeof fileSettings>>()

export function createClient({ getToken, local }: SettingsOptions) {
	const remote = settingsClient('/api/settings', async () => {
		const token = await getToken()
		if (!token) throw new Error('Sign in to manage connected accounts and usage.')
		return { authorization: `Bearer ${token}` }
	})
	if (!local) return remote
	let files = volumes.get(local.volume)
	if (!files) {
		files = fileSettings({
			agent: {
				volume: local.volume,
				paths: IDENTITY_PATHS,
				defaults: IDENTITY_DEFAULTS,
				builtins: BUILTIN_AVATARS
			},
			appearance: {
				volume: local.volume,
				wallpaper: WALLPAPER_PATH,
				dockMaterial: DOCK_MATERIAL_PATH
			}
		})
		volumes.set(local.volume, files)
	}
	return {
		...remote,
		...files,
		readUser: async (_input: Record<string, never>) => local.user(),
		readVersion: async (_input: Record<string, never>) => local.version,
		generateSoul: remote.generateSoul,
		openAccountConnection: async (input: Parameters<typeof remote.readAccountConnection>[0]) => {
			// Reserve the tab during the click, before awaiting the sign-in URL.
			const page = window.open('about:blank', '_blank')
			if (!page) throw new Error('Browser blocked sign-in. Copy the address in Settings.')
			page.opener = null
			try {
				const state = await remote.readAccountConnection(input)
				if (state.status !== 'pending' || !state.prompt)
					throw new Error('Sign-in is no longer pending.')
				const url = new URL(state.prompt.verificationUrl)
				if (url.protocol !== 'https:') throw new Error('Invalid sign-in address.')
				page.location.href = url.href
			} catch (error) {
				page.close()
				throw error
			}
		}
	}
}
