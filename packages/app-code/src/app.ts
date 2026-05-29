import { defineApp } from '@justfiles/app'
import * as v from 'valibot'

export type CodeFile = {
	path: string
	content: string
}

export type CodeMode = 'code' | 'agent'

export type CodeState = {
	mode: CodeMode
	selectedPath: string
	files: CodeFile[]
}

export const initialState: CodeState = {
	mode: 'code',
	selectedPath: '/src/main.ts',
	files: [
		{
			path: '/src/main.ts',
			content: `import { createApp } from './runtime'
import { routes } from './routes'

createApp({
	routes,
	mount: '#app'
})
`
		},
		{
			path: '/src/routes.ts',
			content: `export const routes = [
	{ path: '/', title: 'Dashboard' },
	{ path: '/settings', title: 'Settings' }
]
`
		},
		{
			path: '/src/runtime.ts',
			content: `type AppConfig = {
	routes: Array<{ path: string; title: string }>
	mount: string
}

export function createApp(config: AppConfig) {
	console.log('booting app', config)
}
`
		},
		{
			path: '/package.json',
			content: `{
	"name": "mock-ide-project",
	"type": "module",
	"scripts": {
		"dev": "vite"
	}
}
`
		},
		{
			path: '/README.md',
			content: `# Mock IDE Project

Select files from the explorer to preview their contents.
The play button is a placeholder.
`
		}
	]
}

export const app = defineApp({
	init: initialState,
	actions: (b) => ({
		toggleMode: b.handler({
			description: 'Toggle between code and agent mode.',
			schema: v.object({}),
			examples: [{ params: {} }],
			handler(_, ctx) {
				return { ...ctx.state, mode: ctx.state.mode === 'code' ? 'agent' : 'code' }
			}
		}),
		selectFile: b.handler({
			description: 'Select a file to preview.',
			schema: v.object({ path: v.string() }),
			examples: [{ params: { path: '/src/main.ts' } }],
			handler({ path }, ctx) {
				if (!ctx.state.files.some((file) => file.path === path)) return ctx.state
				return { ...ctx.state, selectedPath: path }
			}
		})
	})
})

export type CodeApp = typeof app
