type Action =
	| { type: 'increment'; params: { amount: number }; actor: string }
	| { type: 'write'; params: { text: string }; actor: string }

export const app = {
	dispatch: async (
		action: Action,
		{ state, files }: { state?: { count: number }; files: { writeFile(path: string, bytes: Uint8Array): Promise<void> } }
	) => {
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
