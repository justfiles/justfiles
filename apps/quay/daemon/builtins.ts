import { join } from 'node:path'
import { type BuiltinSource, builtinSourceFromFs } from '@justfiles/app/builtins/fs'
import { BUILTINS_DIR, SHIPPED } from './resources'

const BUILTINS = [
	{ id: 'app.code', packageDir: 'app-code' },
	{ id: 'app.frieren.files', packageDir: 'app-files' },
	{ id: 'app.justfiles.counter', packageDir: 'app-counter' },
	{ id: 'app.frieren.notes', packageDir: 'app-notes' },
	{ id: 'app.frieren.paint', packageDir: 'app-paint' },
	{ id: 'app.frieren.settings', packageDir: 'app-settings' }
]

export function builtinSource(): Promise<BuiltinSource> {
	return builtinSourceFromFs(BUILTINS.map((app) => rootFor(app)))
}

function rootFor(app: (typeof BUILTINS)[number]): string {
	if (SHIPPED) return join(BUILTINS_DIR, app.id)
	return join(import.meta.dirname, '..', '..', '..', 'packages', app.packageDir, 'dist')
}
