// @ts-check

import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'

// https://astro.build/config
export default defineConfig({
	integrations: [
		starlight({
			title: 'Ghostore Docs',
			sidebar: [
				{
					label: 'Start',
					items: ['overview']
				},
				{
					label: 'System',
					items: ['app', 'fs', 'design']
				},
				{
					label: 'Hosts',
					items: ['frieren', 'quay']
				}
			]
		})
	]
})
