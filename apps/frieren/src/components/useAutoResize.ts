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
		// Our height math (height = scrollHeight) only holds under border-box, where
		// height includes padding; content-box would count the padding twice and
		// leave an empty field looking ~2 lines tall. Enforce it here so the hook is
		// correct regardless of the consumer's CSS.
		el.style.boxSizing = 'border-box'
		const measure = () => {
			// Reset first so scrollHeight reflects content, not the last measured height.
			el.style.height = 'auto'
			el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
			el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden'
		}
		measure()
		// Width changes (viewport/window resize, a sibling control appearing) rewrap
		// the text without changing `value`, so remeasure on width — guarded so our
		// own height writes don't feed the observer back into a loop.
		let lastWidth = el.clientWidth
		const observer = new ResizeObserver(() => {
			if (el.clientWidth === lastWidth) return
			lastWidth = el.clientWidth
			measure()
		})
		observer.observe(el)
		return () => observer.disconnect()
	}, [ref, value, maxHeight])
}
