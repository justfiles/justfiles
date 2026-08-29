import { describe, expect, test } from 'vitest'
import {
	changeAttachedAgentState,
	initialAttachedAgentState,
	readAttachedAgentState
} from './attached-agent'

describe('attached agent state', () => {
	test('fills missing and invalid fields with defaults', () => {
		expect(readAttachedAgentState(null)).toEqual(initialAttachedAgentState)
		expect(
			readAttachedAgentState({
				mode: 'sidebar',
				size: { sheet: 'large', sidebar: 360 },
				open: { notes: true, files: false }
			})
		).toEqual({
			size: { sheet: 280, sidebar: 360 },
			open: { notes: true }
		})
	})

	test('updates one app without dropping another open sidebar', () => {
		const open = changeAttachedAgentState(initialAttachedAgentState, 'notes', {
			size: { sheet: 260, sidebar: 340 },
			open: true
		})
		const both = changeAttachedAgentState(open, 'files', { open: true })

		expect(changeAttachedAgentState(both, 'notes', { open: false })).toEqual({
			size: { sheet: 260, sidebar: 340 },
			open: { files: true }
		})
	})
})
