import type { Volume } from '@justfiles/fs'
import { type LifetimeToken, StaleLifetimeError } from '@justfiles/lifetime'

type Serialize = <T>(task: () => Promise<T>) => Promise<T>

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

export function fenceVolume(
	raw: Volume,
	lifetime: LifetimeToken<number>,
	serialize: Serialize
): { volume: Volume; dispose(): void } {
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
		return (volumePolicy[method] === 'write' ? serialize(run) : run()) as VolumeResult<K>
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
