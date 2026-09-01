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
const listeners = new Set<() => void>()

function emit(): void {
	for (const listener of listeners) listener()
}

export function subscribeDialogs(listener: () => void): () => void {
	listeners.add(listener)
	return () => listeners.delete(listener)
}

export function dialogFor(owner: DialogOwner): OpenDialog | null {
	return dialogs.get(owner) ?? null
}

export function openDialog(owner: DialogOwner, request: DialogRequest): Promise<unknown> {
	if (dialogs.has(owner)) return Promise.reject(new Error('A dialog is already open'))
	return new Promise((resolve, reject) => {
		dialogs.set(owner, { request, resolve, reject })
		emit()
	})
}

export function answerDialog(owner: DialogOwner, result: unknown): void {
	const dialog = dialogs.get(owner)
	if (!dialog) return
	dialogs.delete(owner)
	dialog.resolve(result)
	emit()
}

export function closeDialog(owner: DialogOwner): void {
	const dialog = dialogs.get(owner)
	if (!dialog) return
	dialogs.delete(owner)
	dialog.reject(new Error('Dialog closed'))
	emit()
}

export function closeAllDialogs(): void {
	for (const owner of [...dialogs.keys()]) closeDialog(owner)
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
