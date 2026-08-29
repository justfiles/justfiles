export type AttachedAgentMode = 'sheet' | 'sidebar'

export type AttachedAgentState = {
	mode: AttachedAgentMode
	size: { sheet: number; sidebar: number }
	open: Record<string, true>
}

export type AttachedAgentChange = {
	mode?: AttachedAgentMode
	size?: AttachedAgentState['size']
	open?: boolean
}

export const initialAttachedAgentState: AttachedAgentState = {
	mode: 'sheet',
	size: { sheet: 280, sidebar: 300 },
	open: {}
}

export function readAttachedAgentState(value: unknown): AttachedAgentState {
	if (!value || typeof value !== 'object') return initialAttachedAgentState
	const saved = value as Partial<AttachedAgentState>
	const open: Record<string, true> = {}
	if (saved.open && typeof saved.open === 'object')
		for (const [id, value] of Object.entries(saved.open)) if (value === true) open[id] = true
	return {
		mode: saved.mode === 'sidebar' ? 'sidebar' : 'sheet',
		size: {
			sheet: numberOr(saved.size?.sheet, initialAttachedAgentState.size.sheet),
			sidebar: numberOr(saved.size?.sidebar, initialAttachedAgentState.size.sidebar)
		},
		open
	}
}

export function changeAttachedAgentState(
	state: AttachedAgentState,
	appId: string,
	change: AttachedAgentChange
): AttachedAgentState {
	let open = state.open
	if (change.open === true) open = { ...open, [appId]: true }
	else if (change.open === false && open[appId]) {
		const { [appId]: _closed, ...rest } = open
		open = rest
	}
	return {
		mode: change.mode === 'sheet' || change.mode === 'sidebar' ? change.mode : state.mode,
		size: change.size
			? {
					sheet: numberOr(change.size.sheet, state.size.sheet),
					sidebar: numberOr(change.size.sidebar, state.size.sidebar)
				}
			: state.size,
		open
	}
}

function numberOr(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

export type AttachedAgentClientMessage = {
	shell: 'attached-agent'
	change: AttachedAgentChange
}

export type AttachedAgentServerMessage = {
	assistant: AttachedAgentState
}
