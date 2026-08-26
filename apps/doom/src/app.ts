import { defineApp } from '@justfiles/app'

export const app = defineApp({
	init: {}
})

export type DoomApp = typeof app
