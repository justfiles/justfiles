import { defineConfig } from 'wxt'

function hostPermission(origin: string): string {
	return `${new URL(origin).origin}/*`
}

export default defineConfig({
	manifest: ({ browser }) => ({
		name: 'Just Computer',
		description: 'Use Just Computer from your browser',
		permissions: ['activeTab', 'cookies', 'storage'],
		host_permissions: [
			...new Set(
				[
					import.meta.env.WXT_CLERK_SYNC_HOST,
					import.meta.env.WXT_CLERK_FRONTEND_API_ORIGIN,
					import.meta.env.WXT_FRIEREN_API_ORIGIN
				].map(hostPermission)
			)
		],
		key: browser === 'chrome' ? import.meta.env.WXT_CRX_PUBLIC_KEY : undefined
	})
})
