import { describe, expect, test } from 'vitest'
import { applyAgentFrame, promptResult, type RemoteAgentState, sessionEventFrame } from './protocol'
import type { SessionEvent, StartTurnResult } from './session'

const turn = { id: 'turn-1', input: { text: 'hello', source: 'user' as const } }

describe('agent protocol', () => {
	const idle: RemoteAgentState = { phase: 'idle', activeTurn: null }

	test('removes the local completion promise from an accepted prompt', () => {
		const done = Promise.resolve('hello')
		const result: StartTurnResult = { accepted: true, turn, done }

		expect(promptResult(result)).toEqual({ type: 'prompt_result', accepted: true, turn })
	})

	test('keeps the active turn when a prompt is rejected', () => {
		expect(promptResult({ accepted: false, activeTurn: turn })).toEqual({
			type: 'prompt_result',
			accepted: false,
			activeTurn: turn
		})
	})

	test('maps a session finish without dropping its turn state', () => {
		const event: SessionEvent = {
			type: 'turn_finished',
			turnId: turn.id,
			status: 'failed',
			entries: [],
			error: { message: 'sign in', route: { kind: 'settings', pane: 'accounts' } }
		}

		expect(sessionEventFrame(event, () => ['shown'])).toEqual({
			type: 'turn_finished',
			turnId: turn.id,
			status: 'failed',
			transcript: ['shown'],
			error: event.error
		})
	})

	test('maps the transcript but keeps the live turn in a snapshot', () => {
		const event: SessionEvent = {
			type: 'snapshot',
			snapshot: { entries: [], activeTurn: turn }
		}

		expect(sessionEventFrame(event, () => ['shown'])).toEqual({
			type: 'snapshot',
			transcript: ['shown'],
			activeTurn: turn
		})
	})

	test('uses the server turn for admission and snapshots', () => {
		expect(
			applyAgentFrame(idle, {
				type: 'prompt_result',
				accepted: false,
				activeTurn: turn
			})
		).toEqual({ phase: 'active', activeTurn: turn })
		expect(applyAgentFrame(idle, { type: 'snapshot', transcript: [], activeTurn: turn })).toEqual({
			phase: 'active',
			activeTurn: turn
		})
	})

	test('only the matching finish clears the active turn', () => {
		const active: RemoteAgentState = { phase: 'active', activeTurn: turn }
		const oldFinish = {
			type: 'turn_finished' as const,
			turnId: 'old-turn',
			status: 'completed' as const,
			transcript: []
		}

		expect(applyAgentFrame(active, oldFinish)).toBe(active)
		expect(applyAgentFrame(active, { ...oldFinish, turnId: turn.id })).toEqual(idle)
	})
})
