import { iframeApp } from '../iframe'
import definition from './app.js'
import script from './counter.js?raw'
import html from './index.html?raw'

export const counterApp = iframeApp(definition, {
	'counter.js': script,
	'index.html': html
})
