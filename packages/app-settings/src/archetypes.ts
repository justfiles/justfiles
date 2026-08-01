// The three natures the summoning offers, and the art each one wears. Inlined
// (`?inline` ⇒ data URL) because the app frame's CSP is `img-src data: blob:` with
// `connect-src 'none'`: a separate asset file would simply not load. 192px palette-
// reduced PNGs — about 20 KB for all four, rendered at 96px and 72px.
//
// The art is a copy of frieren's built-in face sets (`src/agent/faces/*/resting.png`),
// deliberately: the shell owns the live expression faces, this app owns the pictures a
// chooser shows. `avatar_variant` in the soul is the word that ties them together.
import assistantArt from './art/assistant.png?inline'
import companionArt from './art/companion.png?inline'
import teacherArt from './art/teacher.png?inline'
import vanillaArt from './art/vanilla.png?inline'

export interface Archetype {
	id: string
	title: string
	tagline: string
	art: string
	// Warmth, initiative, directness — the shape of the disposition, shown as pips so
	// the three cards read as different characters rather than three words.
	disposition: [number, number, number]
}

export const ARCHETYPES: Archetype[] = [
	{
		id: 'teacher',
		title: 'Teacher',
		tagline: 'Leads you to your own answers.',
		art: teacherArt,
		disposition: [4, 2, 2]
	},
	{
		id: 'companion',
		title: 'Companion',
		tagline: 'Beside you, not above you.',
		art: companionArt,
		disposition: [4, 2, 3]
	},
	{
		id: 'assistant',
		title: 'Assistant',
		tagline: 'Gets things done.',
		art: assistantArt,
		disposition: [2, 5, 5]
	}
]

// The face of an agent with no nature yet: the neutral spirit the seeded default wears.
export const SPIRIT_ART = vanillaArt

export function archetypeOf(id: string | null): Archetype | undefined {
	return ARCHETYPES.find((a) => a.id === id)
}

// What the pane shows as the agent's face: an uploaded photo wins, then the art the
// recorded nature points at, then the spirit. Mirrors how the shell resolves it —
// `avatar.png` present ⇒ the photo, otherwise `avatar_variant`.
export function faceOf(photo: string | null, variant: string | null): string {
	return photo ?? archetypeOf(variant)?.art ?? SPIRIT_ART
}
