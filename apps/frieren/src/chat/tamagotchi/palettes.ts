export type Biome = 'meadow' | 'forest' | 'night' | 'ruins'

export interface Palette {
	sky: [string, string]
	far: string
	mid: string
	near: string
	ground: string
	groundDark: string
	trunk: string
	leaf: string
	leafDark: string
	rock: string
	flower: string
	shadow: string
	fog: string
}

export const PALETTES: Record<Biome, Palette> = {
	meadow: {
		sky: ['#b9e3ff', '#ffd7a8'],
		far: '#8a9bbf',
		mid: '#6f8f6a',
		near: '#4f7a49',
		ground: '#7cb55a',
		groundDark: '#4f7a3a',
		trunk: '#5a3a1f',
		leaf: '#3e8a3a',
		leafDark: '#245c24',
		rock: '#8a8578',
		flower: '#f2d06b',
		shadow: 'rgba(0,0,0,0.35)',
		fog: 'rgba(185,227,255,0.55)'
	},
	forest: {
		sky: ['#4a6b8a', '#89a07a'],
		far: '#3b5a6b',
		mid: '#2f5a3c',
		near: '#1f3f28',
		ground: '#355c32',
		groundDark: '#1f3a1c',
		trunk: '#3a2310',
		leaf: '#1f5a2a',
		leafDark: '#0f3a18',
		rock: '#6a6558',
		flower: '#e8c470',
		shadow: 'rgba(0,0,0,0.45)',
		fog: 'rgba(74,107,138,0.55)'
	},
	night: {
		sky: ['#0c1230', '#2a2355'],
		far: '#1a2048',
		mid: '#2a2a55',
		near: '#1a1a3a',
		ground: '#2a2f55',
		groundDark: '#15172e',
		trunk: '#20152a',
		leaf: '#1a2f3a',
		leafDark: '#0a1520',
		rock: '#40455a',
		flower: '#c7b8ff',
		shadow: 'rgba(0,0,0,0.55)',
		fog: 'rgba(12,18,48,0.6)'
	},
	ruins: {
		sky: ['#c9a07a', '#f0c99a'],
		far: '#8a6f55',
		mid: '#7a5a40',
		near: '#55402a',
		ground: '#a88560',
		groundDark: '#6a4a2a',
		trunk: '#3a2a15',
		leaf: '#5a6a30',
		leafDark: '#3a4a1a',
		rock: '#a89a80',
		flower: '#e8a060',
		shadow: 'rgba(0,0,0,0.4)',
		fog: 'rgba(201,160,122,0.55)'
	}
}
