import { GuardError, type Node, type NodeId, type Version } from './store'

export type Observation = { id: NodeId; row: Node | null }
export type SyncConflict = {
	kind: string
	trigger: { id: NodeId; parent: NodeId; version: Version }
	authority: Observation[]
}

export class SyncConflictError extends GuardError {
	readonly conflict: SyncConflict

	constructor(conflict: SyncConflict) {
		super(conflict.kind)
		this.conflict = conflict
	}
}

export class RecoveryError extends Error {}
