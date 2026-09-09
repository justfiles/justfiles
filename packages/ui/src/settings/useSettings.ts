import { imageDataUrl } from '@justfiles/app/image-type'
import { useEffect, useMemo, useState } from 'react'
import {
	type Category,
	colorWallpaper,
	initialState,
	type SettingsState,
	wallpaperColor
} from './model.ts'
import type { SettingsHost } from './types.ts'

export type SettingsActions = ReturnType<typeof useSettings>['actions']

export function useSettings(
	host: SettingsHost,
	category: Category,
	onCategoryChange?: (category: Category) => void
) {
	const [state, setState] = useState<SettingsState>({ ...initialState, category })
	useEffect(() => setState((state) => ({ ...state, category })), [category])
	const actions = useMemo(() => {
		const patch = (value: Partial<SettingsState>) => setState((state) => ({ ...state, ...value }))
		const loadAccounts = async () => patch({ accounts: await host.listAccounts({}) })
		const loadSoul = async () => patch({ soul: await host.readSoul({}) })
		const loadFacts = async () => patch({ facts: await host.readProfile({}) })
		return {
			loadAccounts,
			beginAccountConnection: host.beginAccountConnection,
			readAccountConnection: host.readAccountConnection,
			cancelAccountConnection: host.cancelAccountConnection,
			openAccountConnection: host.openAccountConnection,
			selectCategory: ({ category }: { category: Category }) => {
				patch({ category, error: null })
				onCategoryChange?.(category)
			},
			clearError: (_input: Record<string, never>) => patch({ error: null }),
			loadUsage: async (_input: Record<string, never>) => {
				try {
					patch({ usage: await host.readUsage({}), usageAvailable: true, usageError: null })
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error)
					patch(
						message === 'SETTINGS_UNAVAILABLE' ? { usageAvailable: false } : { usageError: message }
					)
				}
			},
			connectAccount: async (input: Parameters<SettingsHost['connectAccount']>[0]) => {
				await host.connectAccount(input)
				await loadAccounts()
			},
			setAccountEnabled: async (input: Parameters<SettingsHost['setAccountEnabled']>[0]) => {
				await host.setAccountEnabled(input)
				await loadAccounts()
			},
			disconnectAccount: async (input: Parameters<SettingsHost['disconnectAccount']>[0]) => {
				await host.disconnectAccount(input)
				await loadAccounts()
			},
			saveSoul: async (input: Parameters<SettingsHost['writeSoul']>[0]) => {
				await host.writeSoul(input)
				await loadSoul()
			},
			saveFacts: async (input: Parameters<SettingsHost['writeProfile']>[0]) => {
				await host.writeProfile(input)
				await loadFacts()
			},
			generateSoul: host.generateSoul,
			readVersion: host.readVersion,
			readWallpaper: async (_input: Record<string, never>) => {
				const bytes = await host.readWallpaper({})
				const color = bytes ? wallpaperColor(bytes) : null
				return { color, image: bytes && !color ? imageDataUrl(bytes) : null }
			},
			setWallpaperColor: ({ color }: { color: string }) =>
				host.writeWallpaper({ bytes: colorWallpaper(color) }),
			setWallpaperImage: host.writeWallpaper,
			clearWallpaper: (_input: Record<string, never>) => host.writeWallpaper({ bytes: null }),
			readDockMaterial: async (_input: Record<string, never>) =>
				(await host.readDockMaterial({})) ?? 'smoked',
			setDockMaterial: host.writeDockMaterial
		}
	}, [host, onCategoryChange])

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
			load('user', () => host.readUser({})),
			load('providers', () => host.listProviders({})),
			load('accounts', () => host.listAccounts({})),
			load('soul', () => host.readSoul({})),
			load('facts', () => host.readProfile({}))
		]).then(() => {
			if (live) setState((state) => ({ ...state, loading: false }))
		})
		void actions.loadUsage({})
		return () => {
			live = false
		}
	}, [host, actions])
	return { state, actions }
}
