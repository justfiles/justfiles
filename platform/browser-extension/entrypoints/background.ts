import { browser } from 'wxt/browser'
import { getAuthStatus } from '../lib/auth.ts'
import { AppActionsError, run } from '../lib/client.ts'

export type BackgroundResponse =
	| { status: 'signed_in' | 'signed_out' }
	| { status: 'success'; result: unknown }
	| { status: 'error'; error: { code: string; message: string } }

export async function handleMessage(message: unknown): Promise<BackgroundResponse | undefined> {
	const request = message as {
		type?: unknown
		appId?: unknown
		action?: unknown
		params?: unknown
	}
	if (request?.type === 'auth/status') return getAuthStatus()
	if (request?.type !== 'run') return
	if (typeof request.appId !== 'string' || typeof request.action !== 'string')
		return {
			status: 'error',
			error: { code: 'invalid_request', message: 'Invalid action request' }
		}

	try {
		return {
			status: 'success',
			result: await run(request.appId, request.action, request.params)
		}
	} catch (error) {
		return {
			status: 'error',
			error:
				error instanceof AppActionsError
					? { code: error.code, message: error.message }
					: { code: 'action_failed', message: 'Action failed' }
		}
	}
}

export default defineBackground(() => {
	browser.runtime.onMessage.addListener(handleMessage)
})
