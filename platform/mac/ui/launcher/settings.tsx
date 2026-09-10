import '@justfiles/design/design.css'
import '@justfiles/design/mac.css'
import { Settings } from '@justfiles/ui/Settings'
import { type Category, settingsCategory } from '@justfiles/ui/settings/types'
import { createRoot } from 'react-dom/client'

const token = new URLSearchParams(location.search).get('token') ?? ''
const getToken = async () => token
const root = document.getElementById('root')
if (root) {
	const view = createRoot(root)
	const selectCategory = (category: Category) => {
		history.replaceState(null, '', `#${category}`)
		render()
	}
	const render = () =>
		view.render(
			<Settings
				getToken={getToken}
				category={settingsCategory(location.hash.slice(1))}
				onCategoryChange={selectCategory}
			/>
		)
	window.addEventListener('hashchange', render)
	render()
}
