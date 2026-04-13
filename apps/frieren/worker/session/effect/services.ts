import { Context, type Effect, Layer } from 'effect'
import type { Volume as FsVolume } from '@justfiles/fs'
import type {
	CurrentSession,
	InboxCandidate,
	SessionMeta,
	TranscriptLine,
} from '../types.ts'
import type {
	CurrentSessionCorrupt,
	GenerationFailure,
	NotImplemented,
	SessionNotFound,
	StorageFailure,
} from './errors.ts'

export class Volume extends Context.Tag('Frieren/Volume')<
	Volume,
	FsVolume
>() {}

export class SessionClock extends Context.Tag('Frieren/SessionClock')<
	SessionClock,
	{
		readonly nowIso: () => Effect.Effect<string, never>
		readonly nowMillis: () => Effect.Effect<number, never>
	}
>() {}

export class SessionIdGenerator extends Context.Tag('Frieren/SessionIdGenerator')<
	SessionIdGenerator,
	{
		readonly next: () => Effect.Effect<string, never>
	}
>() {}

export class SessionStore extends Context.Tag('Frieren/SessionStore')<
	SessionStore,
	{
		readonly getCurrent: () => Effect.Effect<
			CurrentSession | null,
			NotImplemented | StorageFailure | CurrentSessionCorrupt
		>
		readonly createSession: (input: {
			readonly sessionId: string
			readonly now: string
			readonly latestHandoffPath: string | null
		}) => Effect.Effect<void, NotImplemented | StorageFailure>
		readonly loadMeta: (
			sessionId: string,
		) => Effect.Effect<SessionMeta, NotImplemented | StorageFailure | SessionNotFound>
		readonly saveMeta: (
			meta: SessionMeta,
		) => Effect.Effect<void, NotImplemented | StorageFailure>
		readonly writeCurrent: (
			current: CurrentSession,
		) => Effect.Effect<void, NotImplemented | StorageFailure>
		readonly archiveSession: (input: {
			readonly sessionId: string
			readonly finalSummary: string
			readonly handoff: string
			readonly archivedMeta: SessionMeta
		}) => Effect.Effect<
			{ readonly handoffPath: string },
			NotImplemented | StorageFailure
		>
	}
>() {}

export class TranscriptStore extends Context.Tag('Frieren/TranscriptStore')<
	TranscriptStore,
	{
		readonly append: (
			sessionId: string,
			lines: ReadonlyArray<TranscriptLine>,
		) => Effect.Effect<void, NotImplemented | StorageFailure>
		readonly readLastN: (
			sessionId: string,
			n: number,
		) => Effect.Effect<
			ReadonlyArray<TranscriptLine>,
			NotImplemented | StorageFailure | SessionNotFound
		>
		readonly readAll: (
			sessionId: string,
		) => Effect.Effect<
			ReadonlyArray<TranscriptLine>,
			NotImplemented | StorageFailure | SessionNotFound
		>
	}
>() {}

export class ContextStore extends Context.Tag('Frieren/ContextStore')<
	ContextStore,
	{
		readonly readSoul: () => Effect.Effect<string | null, NotImplemented | StorageFailure>
		readonly readProfile: () => Effect.Effect<string | null, NotImplemented | StorageFailure>
		readonly readRollingSummary: (
			sessionId: string,
		) => Effect.Effect<string | null, NotImplemented | StorageFailure>
		readonly readHandoff: (
			path: string,
		) => Effect.Effect<string | null, NotImplemented | StorageFailure>
		readonly readInbox: () => Effect.Effect<
			ReadonlyArray<InboxCandidate>,
			NotImplemented | StorageFailure
		>
	}
>() {}

export class TextGenerator extends Context.Tag('Frieren/TextGenerator')<
	TextGenerator,
	{
		readonly generate: (input: {
			readonly step: 'final-summary' | 'handoff' | 'rolling-summary' | 'memory-inbox'
			readonly systemPrompt: string
			readonly userPrompt: string
		}) => Effect.Effect<string, NotImplemented | GenerationFailure>
	}
>() {}

export type SessionDraftEnv =
	| Volume
	| SessionClock
	| SessionIdGenerator
	| SessionStore
	| TranscriptStore
	| ContextStore
	| TextGenerator

export type SessionDraftLayer = Layer.Layer<SessionDraftEnv>
