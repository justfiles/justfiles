import { Effect, Layer, ManagedRuntime } from 'effect'
import type { Volume as FsVolume } from '@justfiles/fs'
import type {
	CurrentSession,
	GenerateText,
	NoteEntry,
	SessionMeta,
	TranscriptLine,
} from '../types.ts'
import { PATHS } from '../types.ts'
import { CurrentSessionCorrupt, GenerationFailure, SessionNotFound, StorageFailure } from './errors.ts'
import {
	ContextStore,
	SessionClock,
	type SessionEnv,
	SessionIdGenerator,
	SessionStore,
	TextGenerator,
	TranscriptStore,
	Volume,
} from './services.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()

export function generateSessionId(): string {
	const now = new Date()
	const iso = now.toISOString()
		.replace(/\.\d{3}Z$/, 'Z')
		.replace(/:/g, '-')
	const hex = Math.floor(Math.random() * 0x10000).toString(16).padStart(4, '0')
	return `${iso}_${hex}`
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

export const SessionStoreLive = Layer.effect(SessionStore, Effect.gen(function* () {
	const vol = yield* Volume

	return {
		getCurrent: () =>
			Effect.gen(function* () {
				const text = yield* readTextFile(vol, PATHS.currentSession)
				if (text === null) return null
				return yield* parseJson<CurrentSession, CurrentSessionCorrupt>(
					text,
					() => new CurrentSessionCorrupt({ reason: `Invalid JSON in ${PATHS.currentSession}` }),
				)
			}),
		createSession: ({ sessionId, now, latestHandoffPath }) =>
			Effect.gen(function* () {
				yield* mkdir(vol, PATHS.activeSession(sessionId))
				const meta: SessionMeta = {
					session_id: sessionId,
					started_at: now,
					last_activity_at: now,
					turn_count: 0,
					state: 'active',
				}
				yield* writeJsonFile(vol, PATHS.meta(sessionId), meta)
				yield* writeFile(vol, PATHS.transcript(sessionId), '')
				yield* mkdir(vol, '/sessions')
				const current: CurrentSession = {
					current_session_id: sessionId,
					last_activity_at: now,
					latest_handoff_path: latestHandoffPath,
				}
				yield* writeJsonFile(vol, PATHS.currentSession, current)
			}),
		loadMeta: (sessionId) =>
			Effect.gen(function* () {
				const text = yield* readTextFile(vol, PATHS.meta(sessionId))
				if (text === null) {
					return yield* Effect.fail(new SessionNotFound({ sessionId }))
				}
				return yield* parseJson<SessionMeta, StorageFailure>(
					text,
					(cause) =>
						new StorageFailure({
							operation: 'loadMeta',
							path: PATHS.meta(sessionId),
							cause,
						}),
				)
			}),
		saveMeta: (meta) => writeJsonFile(vol, PATHS.meta(meta.session_id), meta),
		writeCurrent: (current) =>
			Effect.gen(function* () {
				yield* mkdir(vol, '/sessions')
				yield* writeJsonFile(vol, PATHS.currentSession, current)
			}),
		archiveSession: ({ sessionId, finalSummary, handoff, archivedMeta }) =>
			Effect.gen(function* () {
				const activeDir = PATHS.activeSession(sessionId)
				const archivePath = PATHS.archiveSession(sessionId)
				yield* writeFile(vol, `${activeDir}/final-summary.md`, finalSummary)
				yield* writeFile(vol, `${activeDir}/handoff.md`, handoff)
				yield* mkdir(vol, archivePath)
				const entries = yield* readdir(vol, activeDir)
				for (const entry of entries) {
					yield* cp(vol, `${activeDir}/${entry.name}`, `${archivePath}/${entry.name}`)
				}
				yield* writeJsonFile(vol, `${archivePath}/meta.json`, archivedMeta)
				yield* rm(vol, activeDir, { recursive: true })
				return { handoffPath: PATHS.archiveHandoff(sessionId) }
			}),
	}
}))

export const TranscriptStoreLive = Layer.effect(TranscriptStore, Effect.gen(function* () {
	const vol = yield* Volume

	return {
		append: (sessionId, lines) =>
			Effect.gen(function* () {
				const data = lines.map((line) => JSON.stringify(line)).join('\n') + '\n'
				yield* appendFile(vol, PATHS.transcript(sessionId), data)
			}),
		readLastN: (sessionId, n) =>
			Effect.gen(function* () {
				const lines = yield* readTranscriptLines(vol, sessionId)
				return lines.slice(-n)
			}),
		readAll: (sessionId) => readTranscriptLines(vol, sessionId),
	}
}))

export const ContextStoreLive = Layer.effect(ContextStore, Effect.gen(function* () {
	const vol = yield* Volume

	return {
		readSoul: () => readTextFile(vol, PATHS.soul),
		readProfile: () => readTextFile(vol, PATHS.profile),
		readRollingSummary: (sessionId) => readTextFile(vol, PATHS.rollingSummary(sessionId)),
		writeRollingSummary: (sessionId, summary) =>
			writeFile(vol, PATHS.rollingSummary(sessionId), summary),
		readHandoff: (path) => readTextFile(vol, path),
		appendNote: (entry) =>
			appendFile(vol, PATHS.notes, JSON.stringify(entry) + '\n'),
		readNotesForSession: (sessionId) =>
			Effect.gen(function* () {
				const main = yield* readNotesFile(vol, PATHS.notes)
				const processing = yield* readNotesFile(vol, PATHS.notesProcessing)
				return [...main, ...processing].filter((n) => n.sessionId === sessionId)
			}),
		claimNotesForReflection: () =>
			Effect.tryPromise({
				try: async () => {
					if (!(await vol.exists(PATHS.notesProcessing))) {
						if (!(await vol.exists(PATHS.notes))) return []
						await vol.rename(PATHS.notes, PATHS.notesProcessing)
					}
					const raw = dec.decode(await vol.readFile(PATHS.notesProcessing))
					return parseNotesJsonl(raw)
				},
				catch: (cause) =>
					new StorageFailure({
						operation: 'claimNotesForReflection',
						path: PATHS.notes,
						cause,
					}),
			}),
		clearReflectionClaim: () => rm(vol, PATHS.notesProcessing),
	}
}))

export function makeTextGeneratorLive(generateText: GenerateText): Layer.Layer<TextGenerator> {
	return Layer.succeed(TextGenerator, {
		generate: ({ step, systemPrompt, userPrompt }) =>
			Effect.tryPromise({
				try: () => generateText(systemPrompt, userPrompt),
				catch: (cause) => new GenerationFailure({ step, cause }),
			}),
	})
}

export function makeSessionLiveLayer(
	volume: FsVolume,
	generateText: GenerateText,
): Layer.Layer<SessionEnv> {
	const volumeLive = makeVolumeLive(volume)
	const storesLive = Layer.provide(
		Layer.mergeAll(
			SessionStoreLive,
			TranscriptStoreLive,
			ContextStoreLive,
		),
		volumeLive,
	)

	return Layer.mergeAll(
		volumeLive,
		SessionClockLive,
		SessionIdGeneratorLive,
		storesLive,
		makeTextGeneratorLive(generateText),
	)
}

export function makeSessionRuntime(
	volume: FsVolume,
	generateText: GenerateText,
): ManagedRuntime.ManagedRuntime<SessionEnv, never> {
	return ManagedRuntime.make(makeSessionLiveLayer(volume, generateText))
}

function readTextFile(
	vol: FsVolume,
	path: string,
): Effect.Effect<string | null, StorageFailure> {
	return Effect.tryPromise({
		try: async () => {
			if (!(await vol.exists(path))) return null
			return dec.decode(await vol.readFile(path))
		},
		catch: (cause) => new StorageFailure({ operation: 'readTextFile', path, cause }),
	})
}

function writeFile(
	vol: FsVolume,
	path: string,
	content: string,
): Effect.Effect<void, StorageFailure> {
	return Effect.tryPromise({
		try: async () => {
			await vol.writeFile(path, enc.encode(content))
		},
		catch: (cause) => new StorageFailure({ operation: 'writeFile', path, cause }),
	})
}

function appendFile(
	vol: FsVolume,
	path: string,
	content: string,
): Effect.Effect<void, StorageFailure> {
	return Effect.tryPromise({
		try: async () => {
			await vol.appendFile(path, enc.encode(content))
		},
		catch: (cause) => new StorageFailure({ operation: 'appendFile', path, cause }),
	})
}

function writeJsonFile(
	vol: FsVolume,
	path: string,
	data: unknown,
): Effect.Effect<void, StorageFailure> {
	return writeFile(vol, path, JSON.stringify(data, null, '\t'))
}

function mkdir(
	vol: FsVolume,
	path: string,
): Effect.Effect<void, StorageFailure> {
	return Effect.tryPromise({
		try: async () => {
			await vol.mkdir(path, { recursive: true })
		},
		catch: (cause) => new StorageFailure({ operation: 'mkdir', path, cause }),
	})
}

function readdir(
	vol: FsVolume,
	path: string,
): Effect.Effect<Awaited<ReturnType<FsVolume['readdir']>>, StorageFailure> {
	return Effect.tryPromise({
		try: () => vol.readdir(path),
		catch: (cause) => new StorageFailure({ operation: 'readdir', path, cause }),
	})
}

function cp(
	vol: FsVolume,
	from: string,
	to: string,
): Effect.Effect<void, StorageFailure> {
	return Effect.tryPromise({
		try: () => vol.cp(from, to),
		catch: (cause) => new StorageFailure({ operation: 'cp', path: `${from} -> ${to}`, cause }),
	})
}

function rm(
	vol: FsVolume,
	path: string,
	options: { readonly recursive?: boolean } = {},
): Effect.Effect<void, StorageFailure> {
	return Effect.tryPromise({
		try: () => vol.rm(path, options),
		catch: (cause) => new StorageFailure({ operation: 'rm', path, cause }),
	})
}

function parseJson<T, E>(
	text: string,
	onError: (cause: unknown) => E,
): Effect.Effect<T, E> {
	return Effect.try({
		try: () => JSON.parse(text) as T,
		catch: onError,
	})
}

function readNotesFile(
	vol: FsVolume,
	path: string,
): Effect.Effect<ReadonlyArray<NoteEntry>, StorageFailure> {
	return Effect.tryPromise({
		try: async () => {
			if (!(await vol.exists(path))) return []
			const raw = dec.decode(await vol.readFile(path))
			return parseNotesJsonl(raw)
		},
		catch: (cause) =>
			new StorageFailure({ operation: 'readNotesFile', path, cause }),
	})
}

function parseNotesJsonl(raw: string): Array<NoteEntry> {
	if (!raw.trim()) return []
	const out: Array<NoteEntry> = []
	for (const line of raw.split('\n')) {
		const trimmed = line.trim()
		if (!trimmed) continue
		try {
			const parsed = JSON.parse(trimmed) as NoteEntry
			if (parsed && typeof parsed.content === 'string' && typeof parsed.sessionId === 'string') {
				out.push(parsed)
			}
		} catch {
			// skip malformed line
		}
	}
	return out
}

function readTranscriptLines(
	vol: FsVolume,
	sessionId: string,
): Effect.Effect<ReadonlyArray<TranscriptLine>, StorageFailure | SessionNotFound> {
	return Effect.gen(function* () {
		const path = PATHS.transcript(sessionId)
		const raw = yield* readTextFile(vol, path)
		if (raw === null) {
			return yield* Effect.fail(new SessionNotFound({ sessionId }))
		}
		if (!raw.trim()) return []

		return yield* parseJsonLines<TranscriptLine, StorageFailure>(
			raw,
			(cause) =>
				new StorageFailure({
					operation: 'readTranscriptLines',
					path,
					cause,
				}),
		)
	})
}

function parseJsonLines<T, E>(
	text: string,
	onError: (cause: unknown) => E,
): Effect.Effect<ReadonlyArray<T>, E> {
	return Effect.try({
		try: () => text.trim().split('\n').map((line) => JSON.parse(line) as T),
		catch: onError,
	})
}
