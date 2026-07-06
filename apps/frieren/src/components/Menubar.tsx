import type { ReactNode } from 'react'

// The OS menubar strip. Visual styling lives in the shared `ds-menubar` class
// (also used by the app-code preview); `frn-menubar` lays out the app menus on
// the left and the status/actions on the right.
export function Menubar({ children }: { children: ReactNode }) {
	return <header className="ds-menubar frn-menubar">{children}</header>
}
