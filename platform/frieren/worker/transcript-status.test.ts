import type { SessionStatus } from '@justfiles/agent'
import { describe, expect, test, vi } from 'vitest'
import { createTranscriptStatusProjector } from './transcript-status'

const running = (status: object) => status as SessionStatus

describe('Frieren transcript status', () => {
	test('accumulates stripped response text and emits expressions separately', () => {
		const project = createTranscriptStatusProjector()
		const expression = vi.fn()

		expect(
			project(running({ state: 'thinking', detail: { type: 'agent_start' } }), expression)
		).toEqual({ state: 'thinking', label: 'Thinking' })
		expect(expression).toHaveBeenCalledWith(null)

		project(
			running({
				state: 'responding',
				detail: {
					type: 'message_update',
					assistantMessageEvent: { type: 'text_delta', delta: '[ple' }
				}
			}),
			expression
		)
		const second = running({
			state: 'responding',
			detail: {
				type: 'message_update',
				assistantMessageEvent: { type: 'text_delta', delta: 'ased]Found it.' }
			}
		})
		expect(project(second, expression)).toEqual({ state: 'responding', text: 'Found it.' })
		expect(expression).toHaveBeenLastCalledWith('pleased')
		expect(project(second, expression)).toEqual({ state: 'responding', text: 'Found it.' })
	})

	test('sends only a short phrase for tool activity', () => {
		const project = createTranscriptStatusProjector()
		const status = project(
			running({
				state: 'calling_tool',
				detail: {
					type: 'tool_execution_start',
					toolName: 'read_doc',
					args: { id: 'fs', secret: 'never send this' }
				}
			})
		)

		expect(status).toEqual({ state: 'calling_tool', label: 'Reading documentation' })
		expect(JSON.stringify(status)).not.toContain('secret')
	})

	test('idle drops the disposable response', () => {
		const project = createTranscriptStatusProjector()
		project(
			running({
				state: 'responding',
				detail: {
					type: 'message_update',
					assistantMessageEvent: { type: 'text_delta', delta: 'Old reply' }
				}
			})
		)

		expect(project({ state: 'idle' })).toEqual({ state: 'idle' })
		expect(project(running({ state: 'responding' }))).toEqual({
			state: 'responding',
			text: ''
		})
	})
})
