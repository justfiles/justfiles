// @ts-check
//
// Type stub for IDE/tsc. At runtime this file is replaced inside the
// dynamic-worker bundle by the user-authored package's compiled backend
// (resolved from package.json#main of the registered app). Convention: that
// module default-exports the App object.

/** @import { AnyApp } from '@justfiles/app' */

/** @type {AnyApp} */
const app = {
	name: 'stub',
	description: 'stub — replaced at runtime by dynamically loaded app module',
	engine: {
		initial: 'stub',
		context: {},
		states: { stub: {} }
	}
}
export default app
