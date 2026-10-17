import type { ReactNode } from 'react'

export function ScreenWrap({ children }: { children: ReactNode }) {
	return (
		<div className="app-code-screen-outer">
			<div className="app-code-screen-inner">{children}</div>
		</div>
	)
}

export function TextField(props: {
	label: string
	value: string
	onChange?: (value: string) => void
	readOnly?: boolean
	children?: ReactNode
	inputRef?: { current: HTMLInputElement | null }
}) {
	return (
		<label className="app-code-field">
			<span className="app-code-field-label">{props.label}</span>
			<input
				ref={props.inputRef}
				type="text"
				value={props.value}
				readOnly={props.readOnly ?? !props.onChange}
				onChange={(event) => props.onChange?.(event.currentTarget.value)}
				className="app-code-input"
			/>
			{props.children}
		</label>
	)
}

export function IconButton(props: { label: string; title: string; onClick: () => void }) {
	return (
		<button
			type="button"
			title={props.title}
			onClick={props.onClick}
			className="app-code-icon-button"
		>
			{props.label}
		</button>
	)
}

export function ShipButton(props: {
	label: string
	primary: boolean
	disabled: boolean
	onClick: () => void
}) {
	return (
		<button
			type="button"
			disabled={props.disabled}
			onClick={props.onClick}
			className="app-code-ship-button"
			data-primary={props.primary ? 'true' : undefined}
		>
			{props.label}
		</button>
	)
}

export function PrimaryButton(props: {
	label: string
	onClick?: () => void
	type?: 'button' | 'submit'
	disabled?: boolean
}) {
	return (
		<button
			type={props.type ?? 'button'}
			disabled={props.disabled}
			onClick={props.onClick}
			className="app-code-primary-button"
		>
			{props.label}
		</button>
	)
}

export function LinkButton(props: { label: string; onClick: () => void }) {
	return (
		<button type="button" onClick={props.onClick} className="app-code-link-button">
			{props.label}
		</button>
	)
}
