export function greet(params, _context) {
	return `hello, ${params.name}`
}

export const app = {
	dispatch: (action, { state }) => {
		const current = state ?? { count: 0 }
		if (action.type === 'increment') {
			return { ...current, count: current.count + action.params.amount }
		}
		return current
	}
}
