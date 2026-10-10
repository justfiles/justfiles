export type NodeId = string

/** Mode represents permissions, not ownership or a promise of access enforcement. */
export type NodeSpec =
	| {
			type: 'file' | 'directory'
			/** Owner/group/other rwx bits: an integer from 0 to 0o777. */
			mode: number
	  }
	| { type: 'symlink'; target: string; mode: 0o777 }

export type Node = NodeSpec & {
	id: NodeId
	parent: NodeId | null
	name: string
	/** Modification time in nanoseconds since the Unix epoch; precision depends on the backend. */
	mtimeNs: bigint
	/**
	 * Logical byte length for files; UTF-8 target byte length for symlinks.
	 * Directory sizes are backend-defined (0n is allowed), never recursive totals.
	 */
	size: bigint
}
