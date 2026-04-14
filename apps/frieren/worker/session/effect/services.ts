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
			StorageFailure | CurrentSessionCorrupt
		>
		readonly createSession: (input: {
			readonly sessionId: string
			readonly now: string
			readonly latestHandoffPath: string | null
		}) => Effect.Effect<void, StorageFailure>
		readonly loadMeta: (
			sessionId: string,
		) => Effect.Effect<SessionMeta, StorageFailure | SessionNotFound>
		readonly saveMeta: (
			meta: SessionMeta,
		) => Effect.Effect<void, StorageFailure>
		readonly writeCurrent: (
			current: CurrentSession,
		) => Effect.Effect<void, StorageFailure>
		readonly archiveSession: (input: {
			readonly sessionId: string
			readonly finalSummary: string
			readonly handoff: string
			readonly archivedMeta: SessionMeta
		}) => Effect.Effect<
			{ readonly handoffPath: string },
			StorageFailure
		>
	}
>() {}

export class TranscriptStore extends Context.Tag('Frieren/TranscriptStore')<
	TranscriptStore,
	{
		readonly append: (
			sessionId: string,
			lines: ReadonlyArray<TranscriptLine>,
		) => Effect.Effect<void, StorageFailure>
		readonly readLastN: (
			sessionId: string,
			n: number,
		) => Effect.Effect<
			ReadonlyArray<TranscriptLine>,
			StorageFailure | SessionNotFound
		>
		readonly readAll: (
			sessionId: string,
		) => Effect.Effect<
			ReadonlyArray<TranscriptLine>,
			StorageFailure | SessionNotFound
		>
	}
>() {}

export class ContextStore extends Context.Tag('Frieren/ContextStore')<
	ContextStore,
	{
		readonly readSoul: () => Effect.Effect<string | null, StorageFailure>
		readonly readProfile: () => Effect.Effect<string | null, StorageFailure>
		readonly readRollingSummary: (
			sessionId: string,
		) => Effect.Effect<string | null, StorageFailure>
		readonly writeRollingSummary: (
			sessionId: string,
			summary: string,
		) => Effect.Effect<void, StorageFailure>
		readonly readHandoff: (
			path: string,
		) => Effect.Effect<string | null, StorageFailure>
		readonly readInbox: () => Effect.Effect<
			ReadonlyArray<InboxCandidate>,
			StorageFailure
		>
		readonly writeInboxCandidate: (
			filename: string,
			markdown: string,
		) => Effect.Effect<void, StorageFailure>
	}
>() {}

export class TextGenerator extends Context.Tag('Frieren/TextGenerator')<
	TextGenerator,
	{
		readonly generate: (input: {
			readonly step: 'final-summary' | 'handoff' | 'rolling-summary' | 'memory-inbox'
			readonly systemPrompt: string
			readonly userPrompt: string
		}) => Effect.Effect<string, GenerationFailure>
	}
>() {}

export type SessionEnv =
	| Volume
	| SessionClock
	| SessionIdGenerator
	| SessionStore
	| TranscriptStore
	| ContextStore
	| TextGenerator

export type SessionLayer = Layer.Layer<SessionEnv>
