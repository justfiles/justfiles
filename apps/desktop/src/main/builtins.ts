import { join } from 'node:path'
import { type BuiltinSource, builtinSourceFromFs } from '@justfiles/app/builtins/fs'
import { app } from 'electron'

const BUILTINS = [
	{ id: 'app.justfiles.counter', packageDir: 'app-counter' },
	{ id: 'app.frieren.files', packageDir: 'app-files' },
	{ id: 'app.frieren.notes', packageDir: 'app-notes' },
	{ id: 'app.frieren.paint', packageDir: 'app-paint' },
	{ id: 'app.frieren.settings', packageDir: 'app-settings' },
	{ id: 'app.code', packageDir: 'app-code' }
]

export function desktopBuiltinSource(): Promise<BuiltinSource> {
	return builtinSourceFromFs(BUILTINS.map((builtin) => rootFor(builtin)))
}

function rootFor(builtin: (typeof BUILTINS)[number]): string {
	if (app.isPackaged) return join(process.resourcesPath, 'builtins', builtin.id)
	return join(process.cwd(), '..', '..', 'packages', builtin.packageDir, 'dist')
}
