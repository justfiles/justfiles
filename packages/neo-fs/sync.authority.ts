import type { NodeSpec } from './node'

/**
 * An authenticated connection to one shared filesystem tree. Entity IDs are global;
 * mapping them to Store IDs belongs to the client. Transport, authorization, and
 * storage failures reject; expected submission and catch-up outcomes are explicit.
 * Removal is detachment: an entity whose parent becomes null leaves the tree with its
 * subtree intact and remains restorable. The authority purges detached entities after
 * its retention period, and purges arrive as ordinary deletion changes.
 *
 * Retention, the only guarantees a client may rely on:
 * - Outcomes: while a generation is live, a repeated proposal ID returns its recorded
 *   outcome. Once it expires, every proposal under it answers bootstrap-required. The
 *   authority expires generations by any policy.
 * - History: changes() may answer bootstrap-required at any time.
 * - Content: bytes are retained for the current state of every live entity, for detached
 *   entities until purge, and for a bootstrap snapshot until its generation expires.
 *   Superseded content may be collected at any time; clients fetch only the latest state.
 * - Purged IDs: the authority remembers purged entity IDs for at least as long as any
 *   generation that could carry a create for them, and rejects such a create as invalid-tree.
 */
export interface Authority {
	/** Identity of the shared tree this connection serves, known without a network call. */
	readonly root: EntityId

	/**
	 * Return the complete tree at one cursor and a submission generation for this replica.
	 * The returned root equals this connection's root. Snapshot content is retained until
	 * the generation expires. A new generation does not authorize replaying older submissions.
	 */
	bootstrap(replicaId: string): Promise<Bootstrap>

	/**
	 * Return a bounded, contiguous prefix after the cursor, oldest first. Batches
	 * are never split; an empty list means caught up. Continue from the last batch's
	 * cursor. Expired cursors or a different history require bootstrap.
	 */
	changes(after: Cursor): Promise<Changes>

	/**
	 * Rebase the proposal onto current state, then accept all operations or reject all.
	 * Preserve independent changes; reject incompatible intent or an invalid resulting tree.
	 * Accepted state, outcome, and one change batch (possibly empty) commit atomically;
	 * rejection records its outcome and current cursor without changing the tree.
	 * Repeated (generation, id) submissions return that outcome; changing the payload is an
	 * error. Expired generations require bootstrap even after outcome collection.
	 * Corrected proposals use a new proposal ID. Canonical effects arrive through changes
	 * and may differ from the submitted operations. An acknowledgment is not those effects.
	 */
	submit(proposal: Proposal): Promise<Outcome>

	readonly content: {
		/**
		 * Return immutable content, or null if absent. Returned bytes are detached.
		 * Null for a hash the client learned from changes() means the state was superseded:
		 * fetch newer changes and recompute the target before treating it as an error.
		 */
		get(hash: Hash): Promise<Uint8Array | null>

		/** Verify the hash and persist bytes. Repeating an identical upload is harmless. */
		put(hash: Hash, data: Uint8Array): Promise<void>
	}
}

export type EntityId = string

/**
 * Reserved root entry name. Clients keep private sync state there, so the authority
 * rejects any entity with this name under the root as invalid-tree.
 */
export const STATE_DIR = '.sync'
/** SHA-256 of canonical EntityData, including identity and location; see the design doc. */
export type Revision = string
/** Opaque position in one tree's history, distinct from an entity revision. */
export type Cursor = string
/** Authority-issued submission scope for one replica and tree. */
export type Generation = string
/** SHA-256 of the file bytes, encoded as lowercase hex. */
export type Hash = string

/**
 * Filesystem data with global IDs and file bytes referenced by hash.
 * A null parent means the root, or a detached entity awaiting restore or purge.
 */
export type EntityData = NodeSpec & {
	id: EntityId
	parent: EntityId | null
	name: string
} & ({ type: 'file'; content: Hash } | { type: 'directory' | 'symlink' })

/** An accepted node with its state hash. Equal states have equal revisions, even after an undo. */
export type Entity = EntityData & { revision: Revision }

export type Bootstrap = {
	root: EntityId
	generation: Generation
	cursor: Cursor
	/**
	 * Every live entity, including detached subtrees. Content for a detached file is
	 * retained by the authority until purge and need not be fetched at bootstrap.
	 */
	nodes: Entity[]
}

/** Full accepted states and explicit deletions; a deletion is not a filesystem node. */
export type Change = { type: 'put'; node: Entity } | { type: 'delete'; id: EntityId }

export type ChangeBatch = {
	cursor: Cursor
	proposalId: string
	changes: Change[]
}

export type BootstrapRequired = { status: 'bootstrap-required' }

export type Changes = { status: 'ok'; batches: ChangeBatch[] } | BootstrapRequired

/**
 * Shared by pending edits and authority submissions. Create requires a new ID.
 * Update changes only the supplied fields and preserves the entity's type.
 * Empty updates and fields incompatible with the entity's type are invalid.
 * Mode follows NodeSpec; mode updates apply only to files and directories.
 * Resolve paths to global IDs when authoring; moving a directory does not rewrite descendants.
 * Parent and name form one location for rebasing, even when only one is supplied.
 * A parent of null detaches the entity with its subtree in one operation; a later update
 * may re-attach it. Delete is reserved for purging and requires an entity without children.
 */
export type Operation =
	| { type: 'create'; node: EntityData }
	| {
			type: 'update'
			id: EntityId
			changes: {
				parent?: EntityId | null
				name?: string
				content?: Hash
				target?: string
				mode?: number
			}
	  }
	| { type: 'delete'; id: EntityId }

/**
 * IDs are globally unique and reused only for retries. Each entity appears once at most.
 * Base has exactly the operated entity IDs: null for creates, complete before-state data
 * for updates/deletions, with each node's ID matching its key. These are merge inputs,
 * not strict revision guards, and may describe earlier local work never accepted verbatim.
 * Operations describe one atomic change from that base; array order is not a timeline.
 * Clients may collapse consecutive edits to one entity into one operation with the earliest
 * base, and may bundle a connected group of new entities into one proposal. An edit to an
 * existing entity waits for its prerequisites to be installed, keeping its original base.
 * Retries preserve the entire request, including base.
 *
 * Rebase content, location, symlink target, and mode separately; mode is one whole value.
 * Apply a component if current still equals base; an already-satisfied change is a no-op;
 * competing values conflict.
 * Deletion requires unchanged entity data, or an already-absent entity. Never resurrect
 * a deleted entity; a detached one is not deleted. Validate the final root, directory parents,
 * sibling names, and cycles; a root child named STATE_DIR is invalid. Detached entities keep
 * their name, have no siblings to collide with, and cannot be attached beneath their own subtree.
 * Name replacement explicitly deletes or moves the known occupant. New content must exist
 * before acceptance. Base data cannot bypass authorization or current tree validation.
 */
export type Proposal = {
	id: string
	generation: Generation
	base: Record<EntityId, EntityData | null>
	operations: Operation[]
}

export type Outcome =
	| { status: 'accepted'; cursor: Cursor }
	| {
			status: 'rejected'
			/** Authority position at the decision; catch up before capturing the remote side. */
			cursor: Cursor
			reason: 'conflict' | 'invalid-tree' | 'missing-content'
			message: string
	  }
	| BootstrapRequired
