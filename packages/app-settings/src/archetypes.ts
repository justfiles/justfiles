// The three natures the summoning offers. A nature is a SEED for the first draft of a soul
// and nothing after it — what it leaves behind is the avatar picked with it, which is why
// there is no art here any more: the pictures come from `agent.listAvatars` (one built-in
// per nature, `builtin/<id>`), so this app holds copy and no bytes.

export interface Archetype {
	id: string
	title: string
	tagline: string
	// Warmth, initiative, directness — the shape of the disposition, shown as pips so
	// the three cards read as different characters rather than three words.
	disposition: [number, number, number]
}

export const ARCHETYPES: Archetype[] = [
	{
		id: 'teacher',
		title: 'Teacher',
		tagline: 'Leads you to your own answers.',
		disposition: [4, 2, 2]
	},
	{
		id: 'companion',
		title: 'Companion',
		tagline: 'Beside you, not above you.',
		disposition: [4, 2, 3]
	},
	{
		id: 'assistant',
		title: 'Assistant',
		tagline: 'Gets things done.',
		disposition: [2, 5, 5]
	}
]

export function archetypeOf(id: string | null): Archetype | undefined {
	return ARCHETYPES.find((a) => a.id === id)
}
