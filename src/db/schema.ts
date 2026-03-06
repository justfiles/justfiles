import { blob, integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const meta = sqliteTable('meta', {
	key: text('key').primaryKey(),
	value: text('value')
})

export const memories = sqliteTable('memories', {
	id: text('id').primaryKey(),
	scope: text('scope').notNull(),
	title: text('title'),
	raw_text: text('raw_text').notNull(),
	content_hash: text('content_hash').notNull(),
	path: text('path').notNull(),
	occurred_at: text('occurred_at'),
	source: text('source'),
	active: integer('active').notNull().default(1),
	expires_at: text('expires_at'),
	last_retrieved_at: text('last_retrieved_at'),
	retrieval_count: integer('retrieval_count').default(0),
	created_at: text('created_at').notNull(),
	updated_at: text('updated_at').notNull()
})

export const memoryTags = sqliteTable(
	'memory_tags',
	{
		memory_id: text('memory_id')
			.notNull()
			.references(() => memories.id),
		tag: text('tag').notNull()
	},
	(table) => [primaryKey({ columns: [table.memory_id, table.tag] })]
)

export const chunks = sqliteTable('chunks', {
	id: text('id').primaryKey(),
	memory_id: text('memory_id')
		.notNull()
		.references(() => memories.id),
	seq: integer('seq').notNull(),
	start_line: integer('start_line'),
	end_line: integer('end_line'),
	text: text('text').notNull(),
	token_count: integer('token_count'),
	hash: text('hash').notNull(),
	embedding_model: text('embedding_model').notNull(),
	updated_at: text('updated_at').notNull()
})

export const embeddingsCache = sqliteTable(
	'embeddings_cache',
	{
		hash: text('hash').notNull(),
		provider: text('provider').notNull(),
		model: text('model').notNull(),
		dims: integer('dims').notNull(),
		embedding: blob('embedding').notNull(),
		updated_at: text('updated_at').notNull()
	},
	(table) => [primaryKey({ columns: [table.hash, table.provider, table.model] })]
)

export const events = sqliteTable('events', {
	id: text('id').primaryKey(),
	memory_id: text('memory_id').references(() => memories.id),
	event_type: text('event_type').notNull(),
	actor_type: text('actor_type'),
	actor_name: text('actor_name'),
	at: text('at').notNull(),
	payload_json: text('payload_json')
})

export const memoryLinks = sqliteTable(
	'memory_links',
	{
		from_id: text('from_id')
			.notNull()
			.references(() => memories.id),
		to_id: text('to_id')
			.notNull()
			.references(() => memories.id),
		rel_type: text('rel_type').notNull(),
		actor_type: text('actor_type'),
		actor_name: text('actor_name'),
		reason: text('reason'),
		created_at: text('created_at').notNull()
	},
	(table) => [primaryKey({ columns: [table.from_id, table.to_id, table.rel_type] })]
)

export const proposals = sqliteTable('proposals', {
	id: text('id').primaryKey(),
	memory_id: text('memory_id')
		.notNull()
		.references(() => memories.id),
	proposal_type: text('proposal_type').notNull(),
	payload_json: text('payload_json').notNull(),
	reason: text('reason').notNull(),
	status: text('status').notNull().default('pending'),
	actor_type: text('actor_type'),
	actor_name: text('actor_name'),
	created_at: text('created_at').notNull(),
	resolved_at: text('resolved_at'),
	resolved_by: text('resolved_by')
})
