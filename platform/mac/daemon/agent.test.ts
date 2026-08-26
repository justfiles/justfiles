import { expect, test } from 'vitest'
import { abortAgent, classifyFailure } from './agent'

// The AppController is now shared (@justfiles/app, covered by app-controller.test.ts).
// What stays daemon-specific: abort guards on the cold, memoised session, and the failure
// classifier the chat error block + notification banner both key off.

// Abort guards on the memoised shared session: with no session ever built (a cold daemon),
// it must be a no-op rather than building an agent (which needs a backend) just to cancel
// nothing. The "session exists" branch runs the real assistant, so it's exercised live.
test('abort with no built session is a no-op', () => {
	expect(() => abortAgent()).not.toThrow()
})

// Turn failures reach the user classified, not raw: an expired/unauthorised token routes to
// Settings → Accounts, a blown context window / rate limit sends them back to chat, and
// everything else is a generic error that opens chat. This is what the chat error block and
// the notification banner both key off.
test('classifyFailure routes auth errors to Accounts', () => {
	for (const raw of ['401 Unauthorized', 'token expired', 'invalid_api_key']) {
		const failure = classifyFailure(new Error(raw))
		expect(failure.route).toEqual({ kind: 'settings', pane: 'accounts' })
		expect(failure.body).toMatch(/Accounts/)
	}
})

test('classifyFailure routes token-limit errors to a fresh chat', () => {
	for (const raw of ['context length exceeded', 'token limit']) {
		const failure = classifyFailure(new Error(raw))
		expect(failure.route).toEqual({ kind: 'chat' })
		expect(failure.body).toMatch(/new chat/)
	}
})

test('classifyFailure keeps provider rate limits separate from token limits', () => {
	const failure = classifyFailure(new Error('429 rate limit'))
	expect(failure.route).toEqual({ kind: 'chat' })
	expect(failure.body).toMatch(/busy/i)
})

test('classifyFailure distinguishes Kodama quota and network failures', () => {
	const quota = classifyFailure(new Error('429 {"error":{"code":"quota_exceeded"}}'))
	expect(quota.route).toEqual({ kind: 'settings', pane: 'accounts' })
	expect(quota.body).toMatch(/limit reached/i)

	const offline = classifyFailure(new Error('fetch failed: ECONNREFUSED'))
	expect(offline.route).toEqual({ kind: 'chat' })
	expect(offline.body).toMatch(/offline/i)
})

test('classifyFailure falls back to a generic chat error', () => {
	const failure = classifyFailure(new Error('kernel exploded'))
	expect(failure.route).toEqual({ kind: 'chat' })
	expect(failure.body).toBe('Agent error: kernel exploded')
})
