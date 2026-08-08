import {
	decideReset,
	type GenerationState,
	type ResetBody,
	type ResetDecision,
	type ResetResult
} from '@justfiles/core'
import { type Storage, type Volume, volume } from '@justfiles/fs'
import { createLifetimeGate, type LifetimeToken, StaleLifetimeError } from '@justfiles/lifetime'

export interface SerialExecutor {
	run<T>(task: () => Promise<T>): Promise<T>
}

export function createSerialExecutor(): SerialExecutor {
	let tail: Promise<unknown> = Promise.resolve()
	return {
		run<T>(task: () => Promise<T>): Promise<T> {
			const result = tail.then(task, task)
			tail = result.catch(() => undefined)
			return result
		}
	}
}

const volumePolicy = {
	stat: 'read',
	lstat: 'read',
	exists: 'read',
	getXattr: 'read',
	setXattr: 'write',
	listXattr: 'read',
	removeXattr: 'write',
	readFile: 'read',
	writeFile: 'write',
	appendFile: 'write',
	mkdir: 'write',
	readdir: 'read',
	rm: 'write',
	rename: 'write',
	cp: 'write',
	symlink: 'write',
	readlink: 'read',
	chmod: 'write',
	utimes: 'write',
	scan: 'read',
	watch: 'watch'
} as const satisfies Record<keyof Volume, 'read' | 'write' | 'watch'>

type VolumeMethod = keyof Volume
type VolumeArgs<K extends VolumeMethod> = Volume[K] extends (...args: infer Args) => unknown
	? Args
	: never
type VolumeResult<K extends VolumeMethod> = Volume[K] extends (...args: infer _Args) => infer Result
	? Result
	: never

interface FencedVolume {
	readonly volume: Volume
	dispose(): void
}

function fenceVolume(
	raw: Volume,
	lifetime: LifetimeToken<number>,
	executor: SerialExecutor
): FencedVolume {
	const watches = new Set<() => void>()

	function invoke<K extends Exclude<VolumeMethod, 'watch'>>(
		method: K,
		args: VolumeArgs<K>
	): VolumeResult<K> {
		lifetime.assertCurrent()
		const call = raw[method] as unknown as (...callArgs: VolumeArgs<K>) => VolumeResult<K>
		const run = async () => {
			if (volumePolicy[method] === 'write') lifetime.assertCurrent()
			const result = await call(...args)
			lifetime.assertCurrent()
			return result
		}
		return (volumePolicy[method] === 'write' ? executor.run(run) : run()) as VolumeResult<K>
	}

	const watch: Volume['watch'] = async (path, listener, options) => {
		lifetime.assertCurrent()
		let active = true
		const stopRaw = await raw.watch(
			path,
			(event) => {
				if (!active) return
				try {
					lifetime.assertCurrent()
				} catch (error) {
					if (error instanceof StaleLifetimeError) return
					throw error
				}
				listener(event)
			},
			options
		)
		const stop = () => {
			if (!active) return
			active = false
			watches.delete(stop)
			stopRaw()
		}
		try {
			lifetime.assertCurrent()
		} catch (error) {
			stop()
			throw error
		}
		watches.add(stop)
		return stop
	}

	return {
		volume: {
			stat: (...args) => invoke('stat', args),
			lstat: (...args) => invoke('lstat', args),
			exists: (...args) => invoke('exists', args),
			getXattr: (...args) => invoke('getXattr', args),
			setXattr: (...args) => invoke('setXattr', args),
			listXattr: (...args) => invoke('listXattr', args),
			removeXattr: (...args) => invoke('removeXattr', args),
			readFile: (...args) => invoke('readFile', args),
			writeFile: (...args) => invoke('writeFile', args),
			appendFile: (...args) => invoke('appendFile', args),
			mkdir: (...args) => invoke('mkdir', args),
			readdir: (...args) => invoke('readdir', args),
			rm: (...args) => invoke('rm', args),
			rename: (...args) => invoke('rename', args),
			cp: (...args) => invoke('cp', args),
			symlink: (...args) => invoke('symlink', args),
			readlink: (...args) => invoke('readlink', args),
			chmod: (...args) => invoke('chmod', args),
			utimes: (...args) => invoke('utimes', args),
			scan: (...args) => invoke('scan', args),
			watch
		},
		dispose() {
			for (const stop of [...watches]) stop()
		}
	}
}

export interface RuntimeScope<Session, Apps, Kernel> {
	readonly lifetime: LifetimeToken<number>
	readonly volume: Volume
	ready(): Promise<void>
	session(): Session
	apps(): Apps
	kernel(): Kernel
}

interface RuntimeFactories<Session, Apps, Kernel> {
	ready?(scope: RuntimeScope<Session, Apps, Kernel>): Promise<void>
	session(scope: RuntimeScope<Session, Apps, Kernel>): Session
	apps(scope: RuntimeScope<Session, Apps, Kernel>): Apps
	kernel(scope: RuntimeScope<Session, Apps, Kernel>): Kernel
	disposeSession?(session: Session): void
	disposeApps?(apps: Apps): void
	disposeKernel?(kernel: Kernel): void
}

interface OwnedRuntimeScope<Session, Apps, Kernel> extends RuntimeScope<Session, Apps, Kernel> {
	dispose(actual: number): void
}

interface ResetOperations {
	read(): Promise<GenerationState>
	apply(request: Exclude<ResetBody, { mode: 'complete' }>): Promise<ResetDecision>
	clear(resetId: string): Promise<GenerationState>
}

export interface RuntimeHost<Session, Apps, Kernel> {
	current(): RuntimeScope<Session, Apps, Kernel>
	ready(): Promise<RuntimeScope<Session, Apps, Kernel>>
	reset(request: ResetBody): Promise<ResetResult>
}

export function createRuntimeHost<Session, Apps, Kernel>(options: {
	storage: Storage
	generation: number
	executor: SerialExecutor
	factories: RuntimeFactories<Session, Apps, Kernel>
	reset: ResetOperations
}): RuntimeHost<Session, Apps, Kernel> {
	const { storage, executor, factories, reset } = options
	let current = createScope(options.generation)

	function createScope(generation: number): OwnedRuntimeScope<Session, Apps, Kernel> {
		const gate = createLifetimeGate(generation)
		const lifetime = gate.current()
		const fenced = fenceVolume(volume(storage), lifetime, executor)
		let readiness: Promise<void> | undefined
		let session: Session | undefined
		let apps: Apps | undefined
		let kernel: Kernel | undefined
		let disposed = false

		const scope: OwnedRuntimeScope<Session, Apps, Kernel> = {
			lifetime,
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
				session ??= factories.session(scope)
				lifetime.assertCurrent()
				return session
			},
			apps() {
				lifetime.assertCurrent()
				apps ??= factories.apps(scope)
				lifetime.assertCurrent()
				return apps
			},
			kernel() {
				lifetime.assertCurrent()
				kernel ??= factories.kernel(scope)
				lifetime.assertCurrent()
				return kernel
			},
			dispose(actual) {
				if (disposed) return
				disposed = true
				gate.replace(actual)
				if (session !== undefined) factories.disposeSession?.(session)
				if (kernel !== undefined) factories.disposeKernel?.(kernel)
				if (apps !== undefined) factories.disposeApps?.(apps)
				fenced.dispose()
			}
		}
		return scope
	}

	function publish(generation: number): void {
		current = createScope(generation)
	}

	async function ready(): Promise<RuntimeScope<Session, Apps, Kernel>> {
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
				return { ok: true, generation: state.generation }
			}

			const before = await reset.read()
			const decision = decideReset(before, request)
			if (!decision.ok) return decision

			try {
				current.dispose(decision.next.generation)
				const applied = await reset.apply(request)
				if (!applied.ok || applied.next.generation !== decision.next.generation)
					throw new Error('runtime reset CAS changed inside the serial executor')
				publish(applied.next.generation)
				return { ok: true, generation: applied.next.generation }
			} catch (error) {
				publish((await reset.read()).generation)
				throw error
			}
		})
	}

	return { current: () => current, ready, reset: runReset }
}
