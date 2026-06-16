// @ts-check
import { defineConfig } from 'astro/config'
import starlight from '@astrojs/starlight'

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
					label: 'Apps',
					items: [
						{ autogenerate: { directory: 'frieren' } },
						{ autogenerate: { directory: 'quay' } }
					]
				},
				{
					label: 'Packages',
					items: [
						{ autogenerate: { directory: 'app' } },
						{ autogenerate: { directory: 'fs' } },
						{ autogenerate: { directory: 'design' } }
					]
				}
			]
		})
	]
})
