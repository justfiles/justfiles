import { createServer } from 'node:http'
import type { AccountsAdmin, ConnectRef } from '@justfiles/app/accounts'

export function chatgptLogin(accounts: AccountsAdmin): AccountsAdmin {
	let active: { ref: ConnectRef; close(): void } | undefined
	return {
		...accounts,
		beginConnect: async (input) => {
			if (input.providerId !== 'chatgpt') return accounts.beginConnect(input)
			if (active?.ref.operationId === input.operationId) return accounts.readConnect(input)
			active?.close()
			if (input.method === 'device_code') return accounts.beginConnect(input)
			// This is the redirect registered for the Codex installed client.
			const redirect = 'http://localhost:1455/auth/callback'
			const server = createServer(async (request, response) => {
				response.setHeader('cache-control', 'no-store')
				response.setHeader('content-type', 'text/html; charset=utf-8')
				response.setHeader('content-security-policy', "default-src 'none'; frame-ancestors 'none'")
				response.setHeader('referrer-policy', 'no-referrer')
				const callback = URL.parse(request.url ?? '/', redirect)
				if (
					!callback ||
					request.method !== 'GET' ||
					!['localhost:1455', '127.0.0.1:1455'].includes(request.headers.host ?? '') ||
					callback.origin + callback.pathname !== redirect ||
					!callback.searchParams.get('state')
				) {
					response.writeHead(400).end('Invalid sign-in callback.')
					return
				}
				try {
					const result = await accounts.completeConnect({
						...input,
						callbackUrl: callback.href
					})
					const connected = result.status === 'connected'
					response
						.writeHead(connected ? 200 : 400)
						.end(
							connected
								? '<!doctype html><title>Connected</title><h1>ChatGPT is connected</h1><p>Return to Settings. You can close this tab.</p>'
								: '<!doctype html><title>Sign-in ended</title><p>Sign-in did not finish. Return to Settings to try again.</p>'
						)
					attempt.close()
				} catch {
					response
						.writeHead(400)
						.end('Could not complete sign-in. Return to Settings to try again.')
				}
			})
			const timer = setTimeout(() => attempt.close(), 15 * 60_000)
			timer.unref()
			const attempt = {
				ref: input,
				close: () => {
					clearTimeout(timer)
					server.close()
					if (active === attempt) active = undefined
				}
			}
			active = attempt
			try {
				await new Promise<void>((resolve, reject) => {
					server.once('error', reject)
					server.once('close', () => reject(new Error('Sign-in cancelled.')))
					server.listen(1455, '127.0.0.1', resolve)
				})
			} catch (error) {
				attempt.close()
				if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE')
					return accounts.beginConnect({ ...input, method: 'device_code' })
				throw error
			}
			try {
				if (active !== attempt) throw new Error('Sign-in cancelled.')
				const state = await accounts.beginConnect({
					...input,
					method: 'browser'
				})
				if (active !== attempt) await accounts.cancelConnect(input)
				if (state.status !== 'pending') attempt.close()
				return state
			} catch (error) {
				attempt.close()
				throw error
			}
		},
		readConnect: async (input) => {
			const state = await accounts.readConnect(input)
			if (active?.ref.operationId === input.operationId && state.status !== 'pending')
				active.close()
			return state
		},
		cancelConnect: async (input) => {
			if (active?.ref.operationId === input.operationId) active.close()
			await accounts.cancelConnect(input)
		}
	}
}
