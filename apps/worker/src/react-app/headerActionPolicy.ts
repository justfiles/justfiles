import type { HeaderActionMenuItem, HeaderActionSurface } from './HeaderActionMenu'
import type { LayoutMode } from './layoutMode'

type SharedHeaderActionKey = 'organize' | 'search' | 'new-file'

const sharedHeaderActionModes: Record<
	SharedHeaderActionKey,
	Partial<Record<HeaderActionSurface, LayoutMode[]>>
> = {
	organize: {
		sidebar: ['sidebar-only', 'split']
	},
	search: {
		sidebar: ['sidebar-only'],
		editor: ['detail-only', 'split', 'draft']
	},
	'new-file': {
		sidebar: ['sidebar-only'],
		editor: ['detail-only', 'split', 'draft']
	}
}

export function applySharedHeaderActionPolicy(
	item: HeaderActionMenuItem,
	key: SharedHeaderActionKey,
	surface: HeaderActionSurface
): HeaderActionMenuItem {
	return {
		...item,
		layoutModes: sharedHeaderActionModes[key][surface]
	}
}
