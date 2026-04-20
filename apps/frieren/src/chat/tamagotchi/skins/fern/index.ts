import type { SkinBundle } from '../../character'
import avatarUrl from './avatar.png'
import sheetData from './sheet.aseprite.json'
import sheetUrl from './sheet.png'

const bundle: SkinBundle = {
	id: 'fern',
	avatarUrl,
	sheetUrl,
	sheetData,
	displayScale: 28 / 44
}

export default bundle
