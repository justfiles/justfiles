import type { App } from '../app'
import type { Action, Actor } from '../engine'

declare const definition: App<
	Record<string, unknown>,
	Action<string, Record<string, unknown>>,
	Actor,
	Record<string, unknown>
>
export default definition
