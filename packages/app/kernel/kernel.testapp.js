export function greet(params, _context) {
	return `hello, ${params.name}`
}

export const app = {
	dispatch: async (action, { state, files }) => {
		const current = state ?? { count: 0 }
		if (action.type === 'increment') {
			return { ...current, count: current.count + action.params.amount }
		}
		if (action.type === 'write') {
			await files.writeFile('/note.txt', new TextEncoder().encode(action.params.text))
		}
		return current
	}
}
