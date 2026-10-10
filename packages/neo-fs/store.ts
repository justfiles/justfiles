import type { Node, NodeId, NodeSpec } from './node'

/**
 * Filesystem primitives over backend-local IDs. Names are nonempty path components
 * other than `.` or `..`. Volume resolves paths and follows symlinks. Mutating returned
 * values does not change stored data. Calls do not form transactions, and external
 * writers may race them.
 *
 * Store maintains node metadata. Writes update file size and mtimeNs; creating,
 * removing, or moving entries updates the affected parent directories' mtimeNs.
 * Native backends expose only the modeled metadata; host permission details stay
 * behind the backend. Metadata queries do not read file contents.
 * Known filesystem failures follow the FsError contract in error.ts.
 */
export interface Store {
	/** The root is a directory with parent null and an empty name. */
	readonly root: NodeId

	/** Return null when the node does not exist. Other failures reject. */
	get(id: NodeId): Promise<Node | null>

	/** Return null for a missing name; a missing or non-directory parent rejects. */
	lookup(parent: NodeId, name: string): Promise<Node | null>

	/** Immediate children, unordered. A missing or non-directory parent rejects. */
	list(parent: NodeId): Promise<Node[]>

	/**
	 * Create an empty file/directory or a symlink with the specified mode; Volume supplies
	 * it and the store never substitutes a default. An occupied name or an invalid or
	 * unsupported mode rejects.
	 */
	create(parent: NodeId, name: string, spec: NodeSpec): Promise<Node>

	/**
	 * Set file or directory metadata. Missing nodes and symlinks reject.
	 * Omitted fields stay unchanged; an empty update on a file or directory does nothing.
	 * mode must be an integer from 0 to 0o777. mtimeNs is nanoseconds since the Unix
	 * epoch; backend precision may round it. Invalid or unsupported values reject.
	 * Does not flush. Updates across fields are not atomic; failures may leave partial changes.
	 */
	update(id: NodeId, changes: { mode?: number; mtimeNs?: bigint }): Promise<void>

	/** Read a regular file; missing nodes and other node types reject. */
	read(id: NodeId): Promise<Uint8Array>

	/** Replace a regular file's bytes. Does not create; atomic visibility is not guaranteed. */
	write(id: NodeId, data: Uint8Array): Promise<void>

	/**
	 * Rename atomically within this store, replacing a file or empty directory of
	 * compatible type. Moving the root or a directory into its own subtree rejects.
	 */
	move(id: NodeId, parent: NodeId, name: string): Promise<void>

	/** Remove a file, symlink, or empty directory. Missing nodes and the root reject. */
	remove(id: NodeId): Promise<void>

	/**
	 * Persist prior changes to a file or directory, including directory entries.
	 * Durability is limited to the backing storage's lifetime.
	 */
	flush(id: NodeId): Promise<void>
}
