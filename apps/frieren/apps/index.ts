// Server-side registry of runnable apps. Each entry is a self-contained App:
// the runtime looks up an App by `id`, creates a Session from its engine,
// attaches its tools to the agent, and tears them all down on close.
//
// Add a new app by importing it and registering it here.

import type { AnyApp } from '../apps/app'
import { cardApp } from '../apps/card'
import { counterApp } from '../apps/counter'

export const appRegistry: Record<string, AnyApp> = {
	[cardApp.id]: cardApp,
	[counterApp.id]: counterApp
}
