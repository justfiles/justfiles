import type { AccountsAdmin } from '@justfiles/app/accounts'
import { settingsClient } from '@justfiles/ui/settings/http'
import { chatgptLogin } from './chatgpt-login.ts'

export function cloudAccounts(
	local: AccountsAdmin,
	deps: { origin: string; getToken(): Promise<string | null> }
): AccountsAdmin {
	const remote = settingsClient(new URL('/api/settings', deps.origin).href, async () => {
		const token = await deps.getToken()
		if (!token) throw new Error('Sign in to manage cloud accounts.')
		return { authorization: `Bearer ${token}` }
	})
	const cloud = chatgptLogin({
		listProviders: async (input) => ((await deps.getToken()) ? remote.listProviders(input) : []),
		listAccounts: async (input) => ((await deps.getToken()) ? remote.listAccounts(input) : []),
		connect: remote.connectAccount,
		beginConnect: remote.beginAccountConnection,
		completeConnect: remote.completeAccountConnection,
		readConnect: remote.readAccountConnection,
		cancelConnect: remote.cancelAccountConnection,
		setEnabled: remote.setAccountEnabled,
		disconnect: remote.disconnectAccount
	})
	const byProvider = async (providerId: string) =>
		(await local.listProviders({})).some((p) => p.id === providerId) ? local : cloud
	const byAccount = async (accountId: string) =>
		(await local.listAccounts({})).some(
			(a) => a.accountId === accountId && a.providerId !== 'chatgpt'
		)
			? local
			: cloud
	// Email and calendar still run locally; only AI accounts use the cloud on Mac.
	const cloudProvider = (providerId: string) => ['chatgpt', 'frieren'].includes(providerId)
	return {
		listProviders: async (input) => {
			const [device, shared] = await Promise.all([
				local.listProviders(input),
				cloud.listProviders(input)
			])
			return [...device, ...shared.filter((p) => cloudProvider(p.id))]
		},
		listAccounts: async (input) => {
			const [device, shared] = await Promise.all([
				local.listAccounts(input),
				cloud.listAccounts(input)
			])
			// Retire local ChatGPT credentials only after cloud sign-in succeeds.
			if (shared.some((a) => a.providerId === 'chatgpt')) {
				for (const account of device) {
					if (account.providerId === 'chatgpt')
						await local.disconnect({ accountId: account.accountId })
				}
			}
			return [
				...device.filter((a) => a.providerId !== 'chatgpt'),
				...shared.filter((a) => cloudProvider(a.providerId))
			]
		},
		connect: async (input) => (await byProvider(input.providerId)).connect(input),
		beginConnect: async (input) => (await byProvider(input.providerId)).beginConnect(input),
		completeConnect: async (input) => (await byProvider(input.providerId)).completeConnect(input),
		readConnect: async (input) => (await byProvider(input.providerId)).readConnect(input),
		cancelConnect: async (input) => (await byProvider(input.providerId)).cancelConnect(input),
		setEnabled: async (input) => (await byAccount(input.accountId)).setEnabled(input),
		disconnect: async (input) => (await byAccount(input.accountId)).disconnect(input)
	}
}
