import { browser } from 'wxt/browser'
import type { AuthStatus } from '../../lib/auth.ts'

const status = document.querySelector<HTMLParagraphElement>('#status')
const signIn = document.querySelector<HTMLButtonElement>('#sign-in')
if (!status || !signIn) throw new Error('Missing popup elements')

signIn.addEventListener('click', async () => {
	await browser.tabs.create({ url: import.meta.env.WXT_FRIEREN_API_ORIGIN })
	window.close()
})

try {
	const auth = (await browser.runtime.sendMessage({ type: 'auth/status' })) as AuthStatus
	if (auth.status === 'signed_in') {
		status.textContent = 'Signed in'
	} else {
		status.textContent = 'Sign in to Just Computer'
		signIn.hidden = false
	}
} catch {
	status.textContent = 'Sign in to Just Computer'
	signIn.hidden = false
}
