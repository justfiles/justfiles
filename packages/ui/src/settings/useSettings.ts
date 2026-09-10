import { imageDataUrl } from '@justfiles/app/image-type'
import { useEffect, useMemo, useState } from 'react'
import { createClient, type SettingsOptions } from './client.ts'
import {
	type Category,
	colorWallpaper,
	initialState,
	type SettingsState,
	wallpaperColor
} from './model.ts'

export type SettingsActions = ReturnType<typeof useSettings>['actions']

export function useSettings(
	{ getToken, local }: SettingsOptions,
	category: Category,
	onCategoryChange?: (category: Category) => void
) {
	const api = useMemo(() => createClient({ getToken, local }), [getToken, local])
	const [state, setState] = useState<SettingsState>({ ...initialState, category })
	useEffect(() => setState((state) => ({ ...state, category })), [category])
	const actions = useMemo(() => {
		const patch = (value: Partial<SettingsState>) => setState((state) => ({ ...state, ...value }))
		const loadAccounts = async () => patch({ accounts: await api.listAccounts({}) })
		const loadSoul = async () => patch({ soul: await api.readSoul({}) })
		const loadFacts = async () => patch({ facts: await api.readProfile({}) })
		return {
			loadAccounts,
			beginAccountConnection: api.beginAccountConnection,
			readAccountConnection: api.readAccountConnection,
			cancelAccountConnection: api.cancelAccountConnection,
			openAccountConnection: api.openAccountConnection,
			selectCategory: ({ category }: { category: Category }) => {
				patch({ category, error: null })
				onCategoryChange?.(category)
			},
			clearError: (_input: Record<string, never>) => patch({ error: null }),
			loadUsage: async (_input: Record<string, never>) => {
				try {
					patch({ usage: await api.readUsage({}), usageAvailable: true, usageError: null })
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error)
					patch(
						message === 'SETTINGS_UNAVAILABLE' ? { usageAvailable: false } : { usageError: message }
					)
				}
			},
			connectAccount: async (input: Parameters<(typeof api)['connectAccount']>[0]) => {
				await api.connectAccount(input)
				await loadAccounts()
			},
			setAccountEnabled: async (input: Parameters<(typeof api)['setAccountEnabled']>[0]) => {
				await api.setAccountEnabled(input)
				await loadAccounts()
			},
			disconnectAccount: async (input: Parameters<(typeof api)['disconnectAccount']>[0]) => {
				await api.disconnectAccount(input)
				await loadAccounts()
			},
			saveSoul: async (input: Parameters<(typeof api)['writeSoul']>[0]) => {
				await api.writeSoul(input)
				await loadSoul()
			},
			saveFacts: async (input: Parameters<(typeof api)['writeProfile']>[0]) => {
				await api.writeProfile(input)
				await loadFacts()
			},
			generateSoul: api.generateSoul,
			readVersion: api.readVersion,
			readWallpaper: async (_input: Record<string, never>) => {
				const bytes = await api.readWallpaper({})
				const color = bytes ? wallpaperColor(bytes) : null
				return { color, image: bytes && !color ? imageDataUrl(bytes) : null }
			},
			setWallpaperColor: ({ color }: { color: string }) =>
				api.writeWallpaper({ bytes: colorWallpaper(color) }),
			setWallpaperImage: api.writeWallpaper,
			clearWallpaper: (_input: Record<string, never>) => api.writeWallpaper({ bytes: null }),
			readDockMaterial: async (_input: Record<string, never>) =>
				(await api.readDockMaterial({})) ?? 'smoked',
			setDockMaterial: api.writeDockMaterial
		}
	}, [api, onCategoryChange])

	useEffect(() => {
		let live = true
		const load = async <K extends keyof SettingsState>(
			key: K,
			read: () => Promise<SettingsState[K]>
		) => {
			try {
				const value = await read()
				if (live) setState((state) => ({ ...state, [key]: value }))
			} catch (error) {
				if (live)
					setState((state) => ({
						...state,
						error: error instanceof Error ? error.message : String(error)
					}))
			}
		}
		void Promise.all([
			load('user', () => api.readUser({})),
			load('providers', () => api.listProviders({})),
			load('accounts', () => api.listAccounts({})),
			load('soul', () => api.readSoul({})),
			load('facts', () => api.readProfile({}))
		]).then(() => {
			if (live) setState((state) => ({ ...state, loading: false }))
		})
		void actions.loadUsage({})
		return () => {
			live = false
		}
	}, [api, actions])
	return { state, actions }
}
