import {
	decideReset,
	type GenerationState,
	type ResetBody,
	type ResetDecision,
	type ResetResult
} from '@justfiles/core'
import { type Storage, type Volume, volume } from '@justfiles/fs'
import { createLifetimeGate, StaleLifetimeError } from '@justfiles/lifetime'
import { fenceVolume } from './volume-scope.fence.ts'

function createSerialExecutor() {
	let tail: Promise<unknown> = Promise.resolve()
	return {
		run<T>(task: () => Promise<T>): Promise<T> {
			const result = tail.then(task, task)
			tail = result.catch(() => undefined)
			return result
		}
	}
}

export interface VolumeScope<Session, Apps> {
	readonly generation: number
	readonly volume: Volume
	session(): Session
	apps(): Apps
}

interface VolumeScopeFactories<Session, Apps> {
	ready?(scope: VolumeScope<Session, Apps>): Promise<void>
	session(scope: VolumeScope<Session, Apps>, resetInProgress: () => boolean): Session
	apps(scope: VolumeScope<Session, Apps>): Apps
	disposeSession?(session: Session): void
	disposeApps?(apps: Apps): void
}

interface OwnedVolumeScope<Session, Apps> extends VolumeScope<Session, Apps> {
	ready(): Promise<void>
	dispose(actual: number): void
}

interface ResetOperations {
	read(): Promise<GenerationState>
	apply(request: Exclude<ResetBody, { mode: 'complete' }>): Promise<ResetDecision>
	clear(resetId: string): Promise<GenerationState>
}

export interface VolumeScopeOwner<Session, Apps> {
	ready(): Promise<VolumeScope<Session, Apps>>
	reset(request: ResetBody): Promise<ResetResult>
}

export function createVolumeScopeOwner<Session, Apps>(options: {
	storage: Storage
	state: GenerationState
	factories: VolumeScopeFactories<Session, Apps>
	reset: ResetOperations
}): VolumeScopeOwner<Session, Apps> {
	const { storage, factories, reset } = options
	const executor = createSerialExecutor()
	let resetId = options.state.resetId
	let current = createScope(options.state.generation)

	function createScope(generation: number): OwnedVolumeScope<Session, Apps> {
		const gate = createLifetimeGate(generation)
		const lifetime = gate.current()
		const fenced = fenceVolume(volume(storage), lifetime, executor.run)
		let readiness: Promise<void> | undefined
		let session: Session | undefined
		let apps: Apps | undefined
		let disposed = false

		const scope: OwnedVolumeScope<Session, Apps> = {
			generation,
			volume: fenced.volume,
			async ready() {
				lifetime.assertCurrent()
				if (!readiness) {
					const pending = (async () => factories.ready?.(scope))().then(() => undefined)
					readiness = pending
					void pending.catch(() => {
						if (readiness === pending) readiness = undefined
					})
				}
				await readiness
				lifetime.assertCurrent()
			},
			session() {
				lifetime.assertCurrent()
				session ??= factories.session(scope, () => resetId !== undefined)
				lifetime.assertCurrent()
				return session
			},
			apps() {
				lifetime.assertCurrent()
				apps ??= factories.apps(scope)
				lifetime.assertCurrent()
				return apps
			},
			dispose(actual) {
				if (disposed) return
				disposed = true
				gate.replace(actual)
				if (session !== undefined) factories.disposeSession?.(session)
				if (apps !== undefined) factories.disposeApps?.(apps)
				fenced.dispose()
			}
		}
		return scope
	}

	function publish(generation: number): void {
		current = createScope(generation)
	}

	async function ready(): Promise<VolumeScope<Session, Apps>> {
		while (true) {
			const selected = current
			try {
				await selected.ready()
				if (selected === current) return selected
			} catch (error) {
				if (!(error instanceof StaleLifetimeError)) throw error
				await executor.run(async () => undefined)
			}
		}
	}

	async function runReset(request: ResetBody): Promise<ResetResult> {
		return executor.run(async () => {
			if (request.mode === 'complete') {
				const state = await reset.clear(request.resetId)
				resetId = state.resetId
				return { ok: true, generation: state.generation }
			}

			const before = await reset.read()
			resetId = before.resetId
			const decision = decideReset(before, request)
			if (!decision.ok) return decision
			if (decision.replayed)
				return { ok: true, generation: decision.next.generation, replayed: true }

			try {
				current.dispose(decision.next.generation)
				const applied = await reset.apply(request)
				if (!applied.ok || applied.next.generation !== decision.next.generation)
					throw new Error('volume reset CAS changed inside the serial executor')
				resetId = applied.next.resetId
				publish(applied.next.generation)
				return { ok: true, generation: applied.next.generation }
			} catch (error) {
				const state = await reset.read()
				resetId = state.resetId
				publish(state.generation)
				throw error
			}
		})
	}

	return { ready, reset: runReset }
}
