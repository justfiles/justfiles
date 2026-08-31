import { browser } from 'wxt/browser'
import { getAuthStatus } from '../lib/auth.ts'

export default defineBackground(() => {
	browser.runtime.onMessage.addListener((message: unknown) => {
		if ((message as { type?: unknown })?.type !== 'auth/status') return
		return getAuthStatus()
	})
})
