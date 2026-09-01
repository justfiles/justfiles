import { beforeEach, expect, test, vi } from 'vitest'
import {
	answerDialog,
	closeAllDialogs,
	closeDialog,
	dialogFor,
	openDialog,
	subscribeDialogs,
	systemDialog
} from './dialogs'

beforeEach(closeAllDialogs)

test('keeps one pending dialog per owner and resolves the answer', async () => {
	const changed = vi.fn()
	const unsubscribe = subscribeDialogs(changed)
	const result = openDialog('notes', {
		kind: 'confirm',
		title: 'Delete note?',
		confirmLabel: 'Delete',
		destructive: true
	})

	expect(dialogFor('notes')?.request.kind).toBe('confirm')
	answerDialog('notes', true)
	expect(await result).toBe(true)
	expect(dialogFor('notes')).toBeNull()
	expect(changed).toHaveBeenCalledTimes(2)
	unsubscribe()
})

test('allows different windows to wait but rejects overlap in one window', async () => {
	const notes = openDialog('notes', { kind: 'alert', title: 'Notes' })
	const files = openDialog('files', { kind: 'alert', title: 'Files' })
	await expect(openDialog('notes', { kind: 'alert', title: 'Again' })).rejects.toThrow(
		'A dialog is already open'
	)
	answerDialog('notes', undefined)
	answerDialog('files', undefined)
	await Promise.all([notes, files])
})

test('closing an owner rejects its pending request', async () => {
	const result = openDialog('notes', { kind: 'alert', title: 'Waiting' })
	closeDialog('notes')
	await expect(result).rejects.toThrow('Dialog closed')
})

test('system client maps all three result shapes', async () => {
	const alert = systemDialog.alert({ title: 'Done' })
	expect(dialogFor(null)?.request.kind).toBe('alert')
	answerDialog(null, undefined)
	await alert

	const confirm = systemDialog.confirm({ title: 'Reset?', confirmLabel: 'Reset' })
	answerDialog(null, false)
	expect(await confirm).toBe(false)

	const choice = systemDialog.choose({
		title: 'File exists',
		actions: [
			{ id: 'cancel', label: 'Cancel', role: 'cancel' },
			{ id: 'keep-both', label: 'Keep Both' }
		]
	})
	answerDialog(null, 'keep-both')
	expect(await choice).toBe('keep-both')
})
