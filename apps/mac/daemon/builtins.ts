import { join } from 'node:path'
import { type AppStore, builtinStoreFromFs } from '@justfiles/app/appstore/fs'
import { mergeAppStores, runnerAppStore } from '../../shared/justapps'
import { BUILTINS_DIR, SHIPPED } from './resources'

const BUILTINS = [
	{ id: 'justfiles.files', packageDir: 'app-files' },
	{ id: 'justfiles.settings', packageDir: 'app-settings' }
]

// The packaged apps, by id. Authoritative: the packaged store wins an id clash (see
// `mergeAppStores`), so the App Store must neither offer nor install one from JustApps.
export const PACKAGED_IDS = BUILTINS.map((app) => app.id)

// The hosted apps this Mac seeds on a fresh Volume. Code and Draw are deliberately absent:
// you install them from the App Store tile, like any other published app. A seeded app is
// also a TRUSTED one — `reconcile` updates it without asking — so this list is the smallest
// set the Mac wants on day one, not everything JustApps publishes.
const SEEDED = ['justfiles.notes', 'justfiles.paint']

export async function builtinStore(): Promise<AppStore> {
	const [builtin, runner] = await Promise.all([
		builtinStoreFromFs(BUILTINS.map((app) => rootFor(app))),
		runnerAppStore()
	])
	return runner ? mergeAppStores(builtin, seeds(runner)) : builtin
}

// The same JustApps store, with SEEDED as its built-in set — the registry's own default
// (`builtins()`) is one host's choice, not every host's.
function seeds(runner: AppStore): AppStore {
	return {
		...runner,
		builtins: async () =>
			(await Promise.all(SEEDED.map((id) => runner.latest(id)))).filter((app) => app !== null)
	}
}

function rootFor(app: (typeof BUILTINS)[number]): string {
	if (SHIPPED) return join(BUILTINS_DIR, app.id)
	return join(import.meta.dirname, '..', '..', '..', 'packages', app.packageDir, 'dist')
}
