export interface Archetype {
	id: string
	title: string
	tagline: string
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
