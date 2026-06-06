// One router to replace the hand-written `if (cap === x) … else UNAVAILABLE`
// chains every backend used to copy. It maps capability name → unit and, like
// `chroot` over a `Volume`, composes them back into a single `Capabilities`.
// The optional `fallback` is exactly the browser's old behaviour: local units
// for some names, a remote proxy for everything else.

import { CapabilityError } from './error.ts'
import type { Capabilities, Capability, CapabilityCall } from './types.ts'

export function capabilityRegistry(
	map: Record<string, Capability>,
	opts?: { fallback?: Capabilities }
): Capabilities {
	const pick = (c: CapabilityCall): Capabilities => {
		const unit = map[c.capability] ?? opts?.fallback
		if (!unit) throw new CapabilityError('CAPABILITY_UNAVAILABLE', c.capability, c.method)
		return unit
	}
	// `async` so a synchronous miss in `pick` surfaces as a rejected promise.
	return {
		invoke: async (c) => pick(c).invoke(c),
		subscribe: async (c, emit) => pick(c).subscribe(c, emit)
	}
}
