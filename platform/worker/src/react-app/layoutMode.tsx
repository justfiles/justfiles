import { useRouterState } from '@tanstack/react-router'
import { createContext, type ReactNode, useContext, useEffect, useMemo, useState } from 'react'

export type LayoutMode = 'sidebar-only' | 'detail-only' | 'split' | 'other'

type LayoutModeValue = {
	mode: LayoutMode
	isDesktop: boolean
	showingFileDetail: boolean
}

const MOBILE_BREAKPOINT_QUERY = '(min-width: 640px)'

const LayoutModeContext = createContext<LayoutModeValue>({
	mode: 'other',
	isDesktop: false,
	showingFileDetail: false
})

function getLayoutMode(pathname: string, isDesktop: boolean): LayoutModeValue {
	const showingFileDetail = pathname.startsWith('/files/')

	if (pathname === '/files') {
		return {
			mode: 'sidebar-only',
			isDesktop,
			showingFileDetail: false
		}
	}

	if (showingFileDetail) {
		return {
			mode: isDesktop ? 'split' : 'detail-only',
			isDesktop,
			showingFileDetail: true
		}
	}

	return {
		mode: 'other',
		isDesktop,
		showingFileDetail: false
	}
}

export function LayoutModeProvider({ children }: { children: ReactNode }) {
	const pathname = useRouterState({ select: (state) => state.location.pathname })
	const [isDesktop, setIsDesktop] = useState(() => {
		if (typeof window === 'undefined') return false
		return window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches
	})

	useEffect(() => {
		const mediaQuery = window.matchMedia(MOBILE_BREAKPOINT_QUERY)
		const onChange = (event: MediaQueryListEvent) => setIsDesktop(event.matches)

		setIsDesktop(mediaQuery.matches)

		mediaQuery.addEventListener('change', onChange)
		return () => mediaQuery.removeEventListener('change', onChange)
	}, [])

	const value = useMemo(() => getLayoutMode(pathname, isDesktop), [pathname, isDesktop])

	return <LayoutModeContext.Provider value={value}>{children}</LayoutModeContext.Provider>
}

export function useLayoutMode() {
	return useContext(LayoutModeContext)
}
