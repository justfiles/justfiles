import { defineApp } from '@justfiles/app'

export const app = defineApp({
	init: {},
	actions: () => ({})
})

export type DoomApp = typeof app
