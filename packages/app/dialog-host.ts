import type { DialogAction, DialogRequest, DialogTransport } from './dialog.ts'

interface DialogHost extends DialogTransport {
	unmount(): void
}

interface DialogHostOptions {
	readonly source: string
	readonly sourceId?: string
	readonly placement?: 'attached' | 'system'
}

interface PendingDialog {
	request: DialogRequest
	resolve: (result: unknown) => void
	reject: (error: Error) => void
}

let nextId = 0

export function mountDialogHost(
	container: HTMLElement,
	{ source, sourceId, placement = 'attached' }: DialogHostOptions
): DialogHost {
	const queue: PendingDialog[] = []
	let active: PendingDialog | undefined
	let layer: HTMLElement | undefined
	let mounted = true

	const showNext = () => {
		active = queue.shift()
		if (!active) return
		layer = renderDialog(container, active.request, { source, sourceId, placement }, finish)
	}
	const finish = (result: unknown) => {
		layer?.remove()
		layer = undefined
		active?.resolve(result)
		active = undefined
		showNext()
	}

	return {
		request(request) {
			if (!mounted) return Promise.reject(new Error('Dialog host is closed'))
			return new Promise((resolve, reject) => {
				queue.push({ request, resolve, reject })
				if (!active) showNext()
			})
		},
		unmount() {
			if (!mounted) return
			mounted = false
			layer?.remove()
			const pending = [...(active ? [active] : []), ...queue]
			active = undefined
			layer = undefined
			queue.length = 0
			for (const dialog of pending) dialog.reject(new Error('Dialog host is closed'))
		}
	}
}

function renderDialog(
	container: HTMLElement,
	request: DialogRequest,
	options: Required<Pick<DialogHostOptions, 'source' | 'placement'>> &
		Pick<DialogHostOptions, 'sourceId'>,
	answer: (result: unknown) => void
): HTMLElement {
	const id = ++nextId
	const titleId = `ds-dialog-title-${id}`
	const bodyId = `ds-dialog-body-${id}`
	const layer = add(container, 'div', 'ds-dialog-layer')
	layer.dataset.placement = options.placement
	const panel = add(layer, 'div', 'ds-dialog')
	panel.setAttribute('role', 'alertdialog')
	panel.setAttribute('aria-modal', 'true')
	panel.setAttribute('aria-labelledby', titleId)
	if (request.body) panel.setAttribute('aria-describedby', bodyId)

	const head = add(panel, 'div', 'ds-dialog-head')
	add(head, 'span', 'ds-dialog-icon', options.source.slice(0, 1).toUpperCase()).ariaHidden = 'true'
	const content = add(head, 'div')
	add(content, 'h2', 'ds-dialog-title', request.title).id = titleId
	if (request.body) add(content, 'p', 'ds-dialog-body', request.body).id = bodyId

	const source = add(panel, 'div', 'ds-dialog-source')
	source.insertAdjacentHTML(
		'afterbegin',
		'<svg class="ds-dialog-lock" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>'
	)
	const label = add(source, 'span')
	label.append('Asked by ')
	add(label, 'strong', undefined, options.source)
	if (options.sourceId) {
		label.append(' · ')
		add(label, 'code', undefined, options.sourceId)
	}

	const actions = add(panel, 'div', 'ds-dialog-actions')
	for (const action of dialogActions(request)) {
		const button = add(actions, 'button', undefined, action.label)
		button.type = 'button'
		if (action.primary) button.dataset.primary = ''
		if (action.role === 'destructive') button.dataset.danger = ''
		if (action.focused) button.dataset.dialogDefault = ''
		button.addEventListener('click', () => answer(action.result))
	}

	panel.addEventListener('keydown', (event) => {
		if (event.key === 'Escape') {
			const result = cancelResult(request)
			if (!result.found) return
			event.preventDefault()
			answer(result.value)
			return
		}
		if (event.key !== 'Tab') return
		const buttons = [...panel.querySelectorAll<HTMLButtonElement>('button')]
		if (buttons.length < 2) return
		const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
		const next = event.shiftKey
			? (current - 1 + buttons.length) % buttons.length
			: (current + 1) % buttons.length
		event.preventDefault()
		buttons[next]?.focus()
	})
	queueMicrotask(() => panel.querySelector<HTMLButtonElement>('[data-dialog-default]')?.focus())
	return layer
}

function add<K extends keyof HTMLElementTagNameMap>(
	parent: HTMLElement,
	tag: K,
	className?: string,
	text?: string
): HTMLElementTagNameMap[K] {
	const element = document.createElement(tag)
	if (className) element.className = className
	if (text !== undefined) element.textContent = text
	parent.append(element)
	return element
}

function dialogActions(request: DialogRequest): Array<{
	label: string
	result: unknown
	role?: DialogAction['role']
	primary: boolean
	focused: boolean
}> {
	if (request.kind === 'alert')
		return [{ label: 'OK', result: undefined, primary: true, focused: true }]
	if (request.kind === 'confirm')
		return [
			{ label: 'Cancel', result: false, role: 'cancel', primary: false, focused: false },
			{
				label: request.confirmLabel,
				result: true,
				role: request.destructive ? 'destructive' : undefined,
				primary: !request.destructive,
				focused: true
			}
		]
	const primary = defaultChoice(request.actions)
	const focused = primary >= 0 ? primary : Math.max(0, request.actions.findIndex(isCancel))
	return request.actions.map((action, index) => ({
		label: action.label,
		result: action.id,
		role: action.role,
		primary: index === primary,
		focused: index === focused
	}))
}

function defaultChoice(actions: readonly DialogAction[]): number {
	for (let index = actions.length - 1; index >= 0; index--) {
		if (!actions[index]?.role) return index
	}
	return -1
}

function isCancel(action: DialogAction): boolean {
	return action.role === 'cancel'
}

function cancelResult(request: DialogRequest): { found: boolean; value?: unknown } {
	if (request.kind === 'alert') return { found: true }
	if (request.kind === 'confirm') return { found: true, value: false }
	const action = request.actions.find(isCancel)
	return action ? { found: true, value: action.id } : { found: false }
}
