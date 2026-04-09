// TODO: do we need these two?
export type FileMeta = {
	id: string
	title: string | null
	path: string
	updated_at: string
	tags: string[]
	active: number
}

export type LinkInfo = {
	to_id?: string
	from_id?: string
	rel_type: string
	reason: string | null
	created_at: string
	title: string | null
	path: string
}
