import { BUILTIN_AVATARS } from '@justfiles/agent/avatars'
import { IDENTITY_DEFAULTS, IDENTITY_PATHS } from '@justfiles/agent/defaults'
import type { Volume } from '@justfiles/fs'
import { createSettingsHost, type GetUser } from '@justfiles/ui/settings/host'
import { settingsClient } from '@justfiles/ui/settings/http'
import type { SettingsHost } from '@justfiles/ui/settings/types'
import { DOCK_MATERIAL_PATH, WALLPAPER_PATH } from './wallpaper'

export function createBrowserSettings(
	fs: Volume,
	getToken: () => Promise<string | null>,
	user: GetUser
): SettingsHost {
	const remote = settingsClient('/api/settings', async () => {
		if (!navigator.onLine) throw new Error('SETTINGS_OFFLINE')
		const token = await getToken()
		if (!token) throw new Error('Sign in to manage connected accounts and usage.')
		return { authorization: `Bearer ${token}` }
	})
	return {
		...createSettingsHost({
			user,
			version: import.meta.env.VITE_FRIEREN_VERSION,
			agent: {
				volume: fs,
				paths: IDENTITY_PATHS,
				defaults: IDENTITY_DEFAULTS,
				builtins: BUILTIN_AVATARS
			},
			appearance: { volume: fs, wallpaper: WALLPAPER_PATH, dockMaterial: DOCK_MATERIAL_PATH }
		}),
		listProviders: remote.listProviders,
		listAccounts: remote.listAccounts,
		connectAccount: remote.connectAccount,
		beginAccountConnection: remote.beginAccountConnection,
		readAccountConnection: remote.readAccountConnection,
		cancelAccountConnection: remote.cancelAccountConnection,
		openAccountConnection: async (input) => {
			// Open during the click so popup blockers do not discard the awaited sign-in URL.
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
		},
		setAccountEnabled: remote.setAccountEnabled,
		disconnectAccount: remote.disconnectAccount,
		readUsage: remote.readUsage,
		generateSoul: remote.generateSoul
	}
}
