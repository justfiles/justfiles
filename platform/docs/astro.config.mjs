// @ts-check

import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'

// https://astro.build/config
export default defineConfig({
	integrations: [
		starlight({
			title: 'Ghostore Docs'
			// No `sidebar`: Starlight generates it from the collection, which is a
			// symlink to the repo's `docs/`. A hand-written list breaks the build the
			// day a doc is deleted — that is what it did.
		})
	]
})
