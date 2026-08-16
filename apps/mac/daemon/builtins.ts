import { join } from 'node:path'
import { type AppStore, builtinStoreFromFs } from '@justfiles/app/appstore/fs'
import { mergeAppStores, runnerAppStore } from '../../shared/justapps'
import { BUILTINS_DIR, SHIPPED } from './resources'

const BUILTINS = [
	{ id: 'justfiles.files', packageDir: 'app-files' },
	{ id: 'justfiles.settings', packageDir: 'app-settings' }
]

export async function builtinStore(): Promise<AppStore> {
	const [builtin, runner] = await Promise.all([
		builtinStoreFromFs(BUILTINS.map((app) => rootFor(app))),
		runnerAppStore()
	])
	return runner ? mergeAppStores(builtin, runner) : builtin
}

function rootFor(app: (typeof BUILTINS)[number]): string {
	if (SHIPPED) return join(BUILTINS_DIR, app.id)
	return join(import.meta.dirname, '..', '..', '..', 'packages', app.packageDir, 'dist')
}
