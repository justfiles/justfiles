// @ts-check
//
// Type stub for IDE/tsc. At runtime this file is replaced by the user-authored
// app module from worker/dynamic/<id>/app.js, which exports `app` of type
// `App<S, D, Actor, V>`. Engine is `app.engine`; agent (briefing/narrate) is
// `app.agent`.

/** @import { AnyApp } from '../../apps/app' */

/** @type {AnyApp} */
export const app = {
	id: 'stub',
	name: 'stub',
	description: 'stub — replaced at runtime by dynamically loaded app module',
	engine: {
		initial: undefined,
		actions: {},
		step() {
			throw new Error('stub')
		}
	}
}
