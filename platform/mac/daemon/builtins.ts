import { type AppStore, builtinStoreFromFs } from '@justfiles/app/appstore/fs'
import { runnerAppStore } from '../../shared/justapps'

// The hosted apps this Mac seeds on a fresh Volume.
const SEEDED = ['justfiles.files', 'justfiles.settings', 'justfiles.notes', 'justfiles.paint']

export async function builtinStore(): Promise<AppStore> {
	const runner = await runnerAppStore()
	return runner ? seeds(runner) : builtinStoreFromFs([])
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
