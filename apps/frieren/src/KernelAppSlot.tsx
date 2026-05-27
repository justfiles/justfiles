import { useEffect, useRef } from 'react'
import { wrapperOf } from './kernelAppHost'

// Thin React adapter that hands its DOM slot to a kernel-owned wrapper.
// Mounting/unmounting this component only attaches/detaches the wrapper;
// the wrapper itself (and the guest GUI inside it) is owned by
// kernelAppHost and outlives any React re-render. True teardown happens in
// the launcher's close path via kernelAppHost.close(id).
export function KernelAppSlot({ id }: { id: string }) {
	const slotRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		const slot = slotRef.current
		if (!slot) return
		const wrapper = wrapperOf(id)
		if (!wrapper) return
		slot.appendChild(wrapper)
		return () => {
			if (wrapper.parentNode === slot) slot.removeChild(wrapper)
		}
	}, [id])

	return <div ref={slotRef} className="h-full w-full" />
}
