export type Direction = 'across' | 'down'

// Grid as array of equal-length rows.
// Cell chars: '.' empty, '#' block, A-Z letter.
export type Grid = string[]

export type Placement = {
	answer: string
	direction: Direction
	row: number
	col: number
}

export type Slot = {
	id: string
	direction: Direction
	row: number
	col: number
	length: number
	pattern: string
}
