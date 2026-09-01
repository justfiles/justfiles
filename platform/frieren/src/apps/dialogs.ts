import type {
	DialogAction,
	DialogClient,
	DialogContent,
	DialogRequest
} from '@justfiles/app/dialog'

export type DialogOwner = string | null

export interface OpenDialog {
	readonly request: DialogRequest
}

interface PendingDialog extends OpenDialog {
	resolve: (result: unknown) => void
	reject: (error: Error) => void
}

const dialogs = new Map<DialogOwner, PendingDialog>()
const systemQueue: PendingDialog[] = []
const listeners = new Set<() => void>()

function emit(): void {
	for (const listener of listeners) listener()
}

function showNextSystemDialog(): void {
	const next = systemQueue.shift()
	if (next) dialogs.set(null, next)
}

export function subscribeDialogs(listener: () => void): () => void {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

export function dialogFor(owner: DialogOwner): OpenDialog | null {
	return dialogs.get(owner) ?? null
}

export function openDialog(owner: DialogOwner, request: DialogRequest): Promise<unknown> {
	return new Promise((resolve, reject) => {
		const dialog = { request, resolve, reject }
		if (dialogs.has(owner)) {
			if (owner === null) systemQueue.push(dialog)
			else reject(new Error('A dialog is already open'))
			return
		}
		dialogs.set(owner, dialog)
		emit()
	})
}

export function answerDialog(owner: DialogOwner, result: unknown): void {
	const dialog = dialogs.get(owner)
	if (!dialog) return
	dialogs.delete(owner)
	dialog.resolve(result)
	if (owner === null) showNextSystemDialog()
	emit()
}

export function closeDialog(owner: DialogOwner): void {
	const dialog = dialogs.get(owner)
	if (!dialog) return
	dialogs.delete(owner)
	dialog.reject(new Error('Dialog closed'))
	if (owner === null) showNextSystemDialog()
	emit()
}

export function closeAllDialogs(): void {
	const pending = [...dialogs.values(), ...systemQueue]
	dialogs.clear()
	systemQueue.length = 0
	for (const dialog of pending) dialog.reject(new Error('Dialog closed'))
	if (pending.length > 0) emit()
}

export const systemDialog: DialogClient = {
	async alert(options) {
		await openDialog(null, { ...options, kind: 'alert' })
	},
	confirm(options) {
		return openDialog(null, { ...options, kind: 'confirm' }) as Promise<boolean>
	},
	choose: ((options: DialogContent & { actions: readonly DialogAction[] }) =>
		openDialog(null, { ...options, kind: 'choose' })) as DialogClient['choose']
}
