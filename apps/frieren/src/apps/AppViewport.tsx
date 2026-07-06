import { useEffect, useRef } from 'react'
import { subscribeStage, wrapperOf } from './host'

// Thin React adapter that hands its DOM slot to an app-owned wrapper.
// Mounting/unmounting this component only attaches/detaches the wrapper;
// the wrapper itself (and the guest GUI inside it) is owned by the app host
// and outlives any React re-render. True teardown happens in the launcher's
// close path via appHost.close(id).
export function AppViewport({ id }: { id: string }) {
	const slotRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		const slot = slotRef.current
		if (!slot) return
		const attach = () => {
			const wrapper = wrapperOf(id)
			if (wrapper && wrapper.parentNode !== slot) slot.appendChild(wrapper)
		}
		attach()
		// Re-attach if the host recreates this id's stage (e.g. a devkit preview
		// window across a ⟳ Run) so the fresh wrapper lands back in this slot.
		const unsubscribe = subscribeStage(id, attach)
		return () => {
			unsubscribe()
			const wrapper = wrapperOf(id)
			if (wrapper && wrapper.parentNode === slot) slot.removeChild(wrapper)
		}
	}, [id])

	return <div ref={slotRef} className="h-full w-full" />
}
