import type { DialogAction, DialogRequest } from '@justfiles/app/dialog'
import { type KeyboardEvent, useEffect, useId, useRef, useSyncExternalStore } from 'react'
import { answerDialog, type DialogOwner, dialogFor, subscribeDialogs } from '../apps/dialogs'

function defaultChoice(actions: readonly DialogAction[]): number {
	for (let index = actions.length - 1; index >= 0; index--) {
		if (!actions[index]?.role) return index
	}
	return -1
}

function cancel(request: DialogRequest): { canClose: boolean; result?: unknown } {
	if (request.kind === 'alert') return { canClose: true }
	if (request.kind === 'confirm') return { canClose: true, result: false }
	const action = request.actions.find((candidate) => candidate.role === 'cancel')
	return action ? { canClose: true, result: action.id } : { canClose: false }
}

export function DialogHost({
	owner,
	source,
	placement
}: {
	owner: DialogOwner
	source: string
	placement: 'attached' | 'system'
}) {
	const dialog = useSyncExternalStore(
		subscribeDialogs,
		() => dialogFor(owner),
		() => null
	)
	const panel = useRef<HTMLDivElement>(null)
	const titleId = useId()
	const bodyId = useId()

	useEffect(() => {
		if (!dialog) return
		panel.current?.querySelector<HTMLButtonElement>('[data-dialog-default]')?.focus()
	}, [dialog])

	if (!dialog) return null
	const { request } = dialog
	const close = (result: unknown) => answerDialog(owner, result)
	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === 'Escape') {
			const dismissed = cancel(request)
			if (!dismissed.canClose) return
			event.preventDefault()
			close(dismissed.result)
			return
		}
		if (event.key !== 'Tab') return
		const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
		if (buttons.length === 0) return
		const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
		const next = event.shiftKey
			? (current - 1 + buttons.length) % buttons.length
			: (current + 1) % buttons.length
		event.preventDefault()
		buttons[next]?.focus()
	}
	const primaryChoice = request.kind === 'choose' ? defaultChoice(request.actions) : -1
	const focusedChoice =
		request.kind === 'choose'
			? primaryChoice >= 0
				? primaryChoice
				: Math.max(
						0,
						request.actions.findIndex((action) => action.role === 'cancel')
					)
			: -1

	return (
		<div className="ds-dialog-layer" data-placement={placement}>
			<div
				ref={panel}
				className="ds-dialog"
				role="alertdialog"
				aria-modal="true"
				aria-labelledby={titleId}
				aria-describedby={request.body ? bodyId : undefined}
				onKeyDown={onKeyDown}
			>
				<div className="ds-dialog-head">
					<span className="ds-dialog-icon" aria-hidden="true">
						{owner === null ? 'J' : source.slice(0, 1).toUpperCase()}
					</span>
					<div>
						<h2 id={titleId} className="ds-dialog-title">
							{request.title}
						</h2>
						{request.body ? (
							<p id={bodyId} className="ds-dialog-body">
								{request.body}
							</p>
						) : null}
					</div>
				</div>
				<div className="ds-dialog-source">
					<svg
						className="ds-dialog-lock"
						width="11"
						height="11"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2.2"
						aria-hidden="true"
					>
						<rect x="4" y="10" width="16" height="11" rx="2" />
						<path d="M8 10V7a4 4 0 0 1 8 0v3" />
					</svg>
					<span>
						Asked by <strong>{source}</strong>
						{owner === null ? (
							' · not by an app'
						) : (
							<>
								{' '}
								· <code>{owner}</code>
							</>
						)}
					</span>
				</div>
				<div className="ds-dialog-actions">
					{request.kind === 'alert' ? (
						<button type="button" data-primary data-dialog-default onClick={() => close(undefined)}>
							OK
						</button>
					) : request.kind === 'confirm' ? (
						<>
							<button type="button" onClick={() => close(false)}>
								Cancel
							</button>
							<button
								type="button"
								data-primary={request.destructive ? undefined : true}
								data-danger={request.destructive ? true : undefined}
								data-dialog-default
								onClick={() => close(true)}
							>
								{request.confirmLabel}
							</button>
						</>
					) : (
						request.actions.map((action, index) => (
							<button
								key={action.id}
								type="button"
								data-primary={index === primaryChoice ? true : undefined}
								data-danger={action.role === 'destructive' ? true : undefined}
								data-dialog-default={index === focusedChoice ? true : undefined}
								onClick={() => close(action.id)}
							>
								{action.label}
							</button>
						))
					)}
				</div>
			</div>
		</div>
	)
}
