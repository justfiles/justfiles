import type { Failure } from './types.ts'

// Classify why an input went unanswered. Provider failures arrive as plain error text, not
// typed codes, so this matches on the text, as packages/agent's `classifyFailure` does.
export function classifyFailure(reason: string, detail: unknown): Failure {
	if (reason === 'aborted' || reason === 'reset') return { kind: 'aborted', message: reason }
	if (reason === 'no_model') return { kind: 'error', message: 'No model is set.' }
	const message = typeof detail === 'string' ? detail : reason
	if (/usage limit|quota|allowance/i.test(message)) return { kind: 'quota', message }
	if (
		/\b401\b|unauthor|invalid[_ ]?api[_ ]?key|oauth.*refresh.*fail|authentic|expired/i.test(message)
	)
		return { kind: 'auth', message }
	if (/context[_ ]?(length|window)|token limit|maximum context|too many tokens/i.test(message))
		return { kind: 'context', message }
	if (/\b429\b|rate limit/i.test(message)) return { kind: 'rate_limit', message }
	if (/fetch failed|failed to fetch|econnrefused|network error|\boffline\b/i.test(message))
		return { kind: 'network', message }
	return { kind: 'error', message }
}
