CREATE TABLE `chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`memory_id` text NOT NULL,
	`seq` integer NOT NULL,
	`start_line` integer,
	`end_line` integer,
	`text` text NOT NULL,
	`token_count` integer,
	`hash` text NOT NULL,
	`embedding_model` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`memory_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `embeddings_cache` (
	`hash` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`dims` integer NOT NULL,
	`embedding` blob NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`hash`, `provider`, `model`)
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`memory_id` text,
	`event_type` text NOT NULL,
	`actor_type` text,
	`actor_name` text,
	`at` text NOT NULL,
	`payload_json` text,
	FOREIGN KEY (`memory_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`title` text,
	`raw_text` text NOT NULL,
	`content_hash` text NOT NULL,
	`path` text NOT NULL,
	`occurred_at` text,
	`source` text,
	`active` integer DEFAULT 1 NOT NULL,
	`expires_at` text,
	`last_retrieved_at` text,
	`retrieval_count` integer DEFAULT 0,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `memory_links` (
	`from_id` text NOT NULL,
	`to_id` text NOT NULL,
	`rel_type` text NOT NULL,
	`actor_type` text,
	`actor_name` text,
	`reason` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`from_id`, `to_id`, `rel_type`),
	FOREIGN KEY (`from_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `memory_tags` (
	`memory_id` text NOT NULL,
	`tag` text NOT NULL,
	PRIMARY KEY(`memory_id`, `tag`),
	FOREIGN KEY (`memory_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text
);
--> statement-breakpoint
CREATE TABLE `proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`memory_id` text NOT NULL,
	`proposal_type` text NOT NULL,
	`payload_json` text NOT NULL,
	`reason` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`actor_type` text,
	`actor_name` text,
	`created_at` text NOT NULL,
	`resolved_at` text,
	`resolved_by` text,
	FOREIGN KEY (`memory_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE no action
);
