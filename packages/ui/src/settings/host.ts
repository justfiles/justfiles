import { fileSettings } from './files.ts'
import type { AccountsAdmin, UsageSnapshot, UserProfile } from './types.ts'

type GetUsage = () => UsageSnapshot | Promise<UsageSnapshot>
export type GetUser = () => UserProfile | null | Promise<UserProfile | null>

type Files = Parameters<typeof fileSettings>[0]
export interface SettingsHostDeps extends Files {
	accounts?: AccountsAdmin
	openUrl?: (url: string) => void | Promise<void>
	usage?: GetUsage
	user?: GetUser
	version?: string
}
export function createSettingsHost(deps: SettingsHostDeps) {
	const { accounts, usage, user, version, agent, appearance } = deps
	return {
		listProviders: async (input: Parameters<AccountsAdmin['listProviders']>[0]) =>
			accounts ? accounts.listProviders(input) : [],
		listAccounts: async (input: Parameters<AccountsAdmin['listAccounts']>[0]) =>
			accounts ? accounts.listAccounts(input) : [],
		connectAccount: (input: Parameters<AccountsAdmin['connect']>[0]) =>
			accounts ? accounts.connect(input) : unavailable(),
		beginAccountConnection: (input: Parameters<AccountsAdmin['beginConnect']>[0]) =>
			accounts ? accounts.beginConnect(input) : unavailable(),
		completeAccountConnection: (input: Parameters<AccountsAdmin['completeConnect']>[0]) =>
			accounts ? accounts.completeConnect(input) : unavailable(),
		readAccountConnection: (input: Parameters<AccountsAdmin['readConnect']>[0]) =>
			accounts ? accounts.readConnect(input) : unavailable(),
		cancelAccountConnection: (input: Parameters<AccountsAdmin['cancelConnect']>[0]) =>
			accounts ? accounts.cancelConnect(input) : unavailable(),
		openAccountConnection: async (input: Parameters<AccountsAdmin['readConnect']>[0]) => {
			if (!accounts || !deps.openUrl) return unavailable()
			const state = await accounts.readConnect(input)
			if (state.status !== 'pending' || !state.prompt) return unavailable()
			const url = new URL(state.prompt.verificationUrl)
			if (url.protocol !== 'https:') return unavailable()
			await deps.openUrl(url.href)
		},
		setAccountEnabled: (input: Parameters<AccountsAdmin['setEnabled']>[0]) =>
			accounts ? accounts.setEnabled(input) : unavailable(),
		disconnectAccount: (input: Parameters<AccountsAdmin['disconnect']>[0]) =>
			accounts ? accounts.disconnect(input) : unavailable(),
		readUsage: async (_input: Record<string, never>) => (usage ? usage() : unavailable()),
		readUser: async (_input: Record<string, never>) => (await user?.()) ?? null,
		readVersion: async (_input: Record<string, never>) => version ?? unavailable(),
		...fileSettings({ agent, appearance })
	}
}

async function unavailable(): Promise<never> {
	throw new Error('SETTINGS_UNAVAILABLE')
}
