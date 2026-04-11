import { useEffect, useState } from 'react'

type ClientLocation = {
	pathname: string
	search: string
}

function readLocation(): ClientLocation {
	return {
		pathname: window.location.pathname,
		search: window.location.search
	}
}

export function navigate(to: string, options?: { replace?: boolean }) {
	const url = new URL(to, window.location.origin)
	const next = `${url.pathname}${url.search}`
	const current = `${window.location.pathname}${window.location.search}`
	if (next === current) return

	if (options?.replace) {
		window.history.replaceState(null, '', next)
	} else {
		window.history.pushState(null, '', next)
	}
	window.dispatchEvent(new PopStateEvent('popstate'))
}

export function useClientLocation(): ClientLocation {
	const [location, setLocation] = useState<ClientLocation>(() => readLocation())

	useEffect(() => {
		const handlePopState = () => setLocation(readLocation())
		window.addEventListener('popstate', handlePopState)
		return () => window.removeEventListener('popstate', handlePopState)
	}, [])

	return location
}
