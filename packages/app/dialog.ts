export interface DialogContent {
	readonly title: string
	readonly body?: string
}

export interface ConfirmDialogOptions extends DialogContent {
	readonly confirmLabel: string
	readonly destructive?: boolean
}

export interface DialogAction<Id extends string = string> {
	readonly id: Id
	readonly label: string
	readonly role?: 'cancel' | 'destructive'
}

export interface DialogClient {
	alert(options: DialogContent): Promise<void>
	confirm(options: ConfirmDialogOptions): Promise<boolean>
	choose<const Actions extends readonly [DialogAction, DialogAction?, DialogAction?]>(
		options: DialogContent & { readonly actions: Actions }
	): Promise<NonNullable<Actions[number]>['id']>
}

export type DialogRequest =
	| ({ readonly kind: 'alert' } & DialogContent)
	| ({ readonly kind: 'confirm' } & ConfirmDialogOptions)
	| ({ readonly kind: 'choose'; readonly actions: readonly DialogAction[] } & DialogContent)

export interface DialogTransport {
	request(request: DialogRequest): Promise<unknown>
}
