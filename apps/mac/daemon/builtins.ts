import { join } from 'node:path'
import { type AppStore, builtinStoreFromFs } from '@justfiles/app/appstore/fs'
import { BUILTINS_DIR, SHIPPED } from './resources'

const BUILTINS = [
	{ id: 'justfiles.code', packageDir: 'app-code' },
	{ id: 'justfiles.files', packageDir: 'app-files' },
	{ id: 'justfiles.paint', packageDir: 'app-paint' },
	{ id: 'justfiles.settings', packageDir: 'app-settings' }
]

export function builtinStore(): Promise<AppStore> {
	return builtinStoreFromFs(BUILTINS.map((app) => rootFor(app)))
}

function rootFor(app: (typeof BUILTINS)[number]): string {
	if (SHIPPED) return join(BUILTINS_DIR, app.id)
	return join(import.meta.dirname, '..', '..', '..', 'packages', app.packageDir, 'dist')
}
