import { Effect, Layer } from 'effect'
import type { Volume as FsVolume } from '@justfiles/fs'
import { generateSessionId } from '../manager.ts'
import { NotImplemented } from './errors.ts'
import {
	ContextStore,
	SessionClock,
	SessionIdGenerator,
	SessionStore,
	TextGenerator,
	TranscriptStore,
	Volume,
} from './services.ts'

function notImplemented<A>(service: string, operation: string): Effect.Effect<A, NotImplemented> {
	return Effect.fail(new NotImplemented({ service, operation }))
}

export function makeVolumeLive(volume: FsVolume): Layer.Layer<Volume> {
	return Layer.succeed(Volume, volume)
}

export const SessionClockLive = Layer.succeed(SessionClock, {
	nowIso: () => Effect.sync(() => new Date().toISOString()),
	nowMillis: () => Effect.sync(() => Date.now()),
})

export const SessionIdGeneratorLive = Layer.succeed(SessionIdGenerator, {
	next: () => Effect.sync(() => generateSessionId()),
})

export const SessionStoreDraft = Layer.succeed(SessionStore, {
	getCurrent: () => notImplemented('SessionStore', 'getCurrent'),
	createSession: () => notImplemented('SessionStore', 'createSession'),
	loadMeta: () => notImplemented('SessionStore', 'loadMeta'),
	saveMeta: () => notImplemented('SessionStore', 'saveMeta'),
	writeCurrent: () => notImplemented('SessionStore', 'writeCurrent'),
	archiveSession: () => notImplemented('SessionStore', 'archiveSession'),
})

export const TranscriptStoreDraft = Layer.succeed(TranscriptStore, {
	append: () => notImplemented('TranscriptStore', 'append'),
	readLastN: () => notImplemented('TranscriptStore', 'readLastN'),
	readAll: () => notImplemented('TranscriptStore', 'readAll'),
})

export const ContextStoreDraft = Layer.succeed(ContextStore, {
	readSoul: () => notImplemented('ContextStore', 'readSoul'),
	readProfile: () => notImplemented('ContextStore', 'readProfile'),
	readRollingSummary: () => notImplemented('ContextStore', 'readRollingSummary'),
	readHandoff: () => notImplemented('ContextStore', 'readHandoff'),
	readInbox: () => notImplemented('ContextStore', 'readInbox'),
})

export const TextGeneratorDraft = Layer.succeed(TextGenerator, {
	generate: () => notImplemented('TextGenerator', 'generate'),
})

export function makeSessionDraftRuntime(volume: FsVolume): Layer.Layer<import('./services.ts').SessionDraftEnv> {
	return Layer.mergeAll(
		makeVolumeLive(volume),
		SessionClockLive,
		SessionIdGeneratorLive,
		SessionStoreDraft,
		TranscriptStoreDraft,
		ContextStoreDraft,
		TextGeneratorDraft,
	)
}
