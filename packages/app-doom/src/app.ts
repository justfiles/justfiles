import { defineApp } from '@justfiles/app/kernel/sdk'

export const app = defineApp({
	init: {},
	handlers: {}
})

export type DoomApp = typeof app
