import avatarUrl from './avatar.png'
import sheetData from './sheet.aseprite.json'
import sheetUrl from './sheet.png'
import type { SkinBundle } from '../../character'

const bundle: SkinBundle = {
	id: 'frieren',
	avatarUrl,
	sheetUrl,
	sheetData,
	displayScale: 28 / 54
}

export default bundle
