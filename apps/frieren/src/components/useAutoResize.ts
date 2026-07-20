import { type RefObject, useLayoutEffect } from 'react'

// Grow a textarea to fit its content, capped at maxHeight — past the cap it
// scrolls instead of pushing the UI open (the iMessage composer feel). Re-runs
// whenever the value changes, so paste and clear both settle to the right size.
export function useAutoResize(
	ref: RefObject<HTMLTextAreaElement | null>,
	value: string,
	maxHeight: number
) {
	// biome-ignore lint/correctness/useExhaustiveDependencies: value is the change trigger — we re-measure whenever the text changes, even though the body reads scrollHeight rather than value itself.
	useLayoutEffect(() => {
		const el = ref.current
		if (!el) return
		// Reset first so scrollHeight reflects content, not the last measured height.
		el.style.height = 'auto'
		el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
		el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden'
	}, [ref, value, maxHeight])
}
