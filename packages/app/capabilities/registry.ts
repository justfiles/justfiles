// One router to replace the hand-written `if (cap === x) … else UNAVAILABLE`
// chains every backend used to copy. It maps capability name → unit and, like
// `chroot` over a `Volume`, composes them back into a single `Capabilities`.
// The optional `fallback` is exactly the browser's old behaviour: local units
// for some names, a remote proxy for everything else.

import type { Kernel } from '../kernel.ts'
import { CapabilityError } from './error.ts'
import type { Capabilities, Capability, CapabilityCall } from './types.ts'

// A unit is either a ready `Capability` or a factory the KERNEL resolves with
// itself — so a kernel-reflective unit (devkit, which reads installed bundles and
// installs drafts) gets the exact kernel it lives in WITHOUT wrapping the whole
// map. A map with any factory yields a `(kernel) => Capabilities` the kernel calls
// once (its `capabilities` seam accepts both forms); an all-ready map stays a plain
// `Capabilities`, so RPC servers and tests keep passing the result directly.
type Unit = Capability | ((kernel: Kernel) => Capability)

export function capabilityRegistry(
	map: Record<string, Capability>,
	opts?: { fallback?: Capabilities }
): Capabilities
export function capabilityRegistry(
	map: Record<string, Unit>,
	opts?: { fallback?: Capabilities }
): (kernel: Kernel) => Capabilities
export function capabilityRegistry(
	map: Record<string, Unit>,
	opts?: { fallback?: Capabilities }
): Capabilities | ((kernel: Kernel) => Capabilities) {
	// Build the router over READY units; factory entries are resolved against the
	// `kernel` the seam hands in (absent in the all-ready case — never a factory then).
	const router = (kernel?: Kernel): Capabilities => {
		const ready: Record<string, Capability> = {}
		for (const name in map) {
			const unit = map[name]
			if (unit) ready[name] = typeof unit === 'function' ? unit(kernel as Kernel) : unit
		}
		const pick = (c: CapabilityCall): Capabilities => {
			const unit = ready[c.capability] ?? opts?.fallback
			if (!unit) throw new CapabilityError('CAPABILITY_UNAVAILABLE', c.capability, c.method)
			return unit
		}
		// `async` so a synchronous miss in `pick` surfaces as a rejected promise.
		return {
			invoke: async (c) => pick(c).invoke(c),
			subscribe: async (c, emit) => pick(c).subscribe(c, emit)
		}
	}
	// Any factory entry → defer to a kernel-taking factory; otherwise resolve now.
	const deferred = Object.values(map).some((unit) => typeof unit === 'function')
	return deferred ? router : router()
}
