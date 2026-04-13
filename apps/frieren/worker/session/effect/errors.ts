import { Data } from 'effect'

export class NotImplemented extends Data.TaggedError('NotImplemented')<{
	readonly service: string
	readonly operation: string
}> {}

export class SessionNotFound extends Data.TaggedError('SessionNotFound')<{
	readonly sessionId: string
}> {}

export class CurrentSessionCorrupt extends Data.TaggedError('CurrentSessionCorrupt')<{
	readonly reason: string
}> {}

export class StorageFailure extends Data.TaggedError('StorageFailure')<{
	readonly operation: string
	readonly path?: string
	readonly cause?: unknown
}> {}

export class GenerationFailure extends Data.TaggedError('GenerationFailure')<{
	readonly step: 'final-summary' | 'handoff' | 'rolling-summary' | 'memory-inbox'
	readonly cause?: unknown
}> {}

