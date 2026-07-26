import { join } from 'node:path'
import { type AppStore, builtinStoreFromFs } from '@justfiles/app/appstore/fs'
import { BUILTINS_DIR, SHIPPED } from './resources'

const BUILTINS = [
	{ id: 'app.justfiles.frieren.code', packageDir: 'app-code' },
	{ id: 'app.justfiles.frieren.files', packageDir: 'app-files' },
	{ id: 'app.justfiles.frieren.notes', packageDir: 'app-notes' },
	{ id: 'app.justfiles.frieren.paint', packageDir: 'app-paint' },
	{ id: 'app.justfiles.frieren.settings', packageDir: 'app-settings' }
]

export function builtinStore(): Promise<AppStore> {
	return builtinStoreFromFs(BUILTINS.map((app) => rootFor(app)))
}

function rootFor(app: (typeof BUILTINS)[number]): string {
	if (SHIPPED) return join(BUILTINS_DIR, app.id)
	return join(import.meta.dirname, '..', '..', '..', 'packages', app.packageDir, 'dist')
}
