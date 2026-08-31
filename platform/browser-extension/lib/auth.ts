export type AuthStatus = { status: 'signed_in' } | { status: 'signed_out' }

function required(value: string | undefined, name: string): string {
	if (!value) throw new Error(`Missing ${name}`)
	return value
}

export async function getSessionToken(): Promise<string | null> {
	const { createClerkClient } = await import('@clerk/chrome-extension/client')
	const clerk = await createClerkClient({
		publishableKey: required(
			import.meta.env.WXT_CLERK_PUBLISHABLE_KEY,
			'WXT_CLERK_PUBLISHABLE_KEY'
		),
		syncHost: required(import.meta.env.WXT_CLERK_SYNC_HOST, 'WXT_CLERK_SYNC_HOST'),
		background: true
	})
	return (await clerk.session?.getToken()) ?? null
}

export async function getAuthStatus(): Promise<AuthStatus> {
	return (await getSessionToken()) ? { status: 'signed_in' } : { status: 'signed_out' }
}
