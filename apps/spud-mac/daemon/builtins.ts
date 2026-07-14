import { join } from 'node:path'
import { type AppStore, builtinStoreFromFs } from '@justfiles/app/appstore/fs'
import { BUILTINS_DIR, SHIPPED } from './resources'

const BUILTINS = [
	{ id: 'computer.spud.code', packageDir: 'app-code' },
	{ id: 'computer.spud.files', packageDir: 'app-files' },
	{ id: 'computer.spud.counter', packageDir: 'app-counter' },
	{ id: 'computer.spud.notes', packageDir: 'app-notes' },
	{ id: 'computer.spud.paint', packageDir: 'app-paint' },
	{ id: 'computer.spud.settings', packageDir: 'app-settings' }
]

export function builtinStore(): Promise<AppStore> {
	return builtinStoreFromFs(BUILTINS.map((app) => rootFor(app)))
}

function rootFor(app: (typeof BUILTINS)[number]): string {
	if (SHIPPED) return join(BUILTINS_DIR, app.id)
	return join(import.meta.dirname, '..', '..', '..', 'packages', app.packageDir, 'dist')
}
