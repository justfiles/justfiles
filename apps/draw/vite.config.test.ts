import { describe, expect, it } from 'vitest'
import { inlineExcalidrawFonts } from './vite.config'

describe('Draw build', () => {
	it('embeds small fonts and leaves Xiaolai on the network', () => {
		const bundled = './fonts/Virgil/Virgil-Regular.woff2'
		const remote = './fonts/Xiaolai/Xiaolai-Regular-bafff7a14c27403dcc6cf1432e8ea836.woff2'
		const code = inlineExcalidrawFonts(`const bundled = '${bundled}'; const remote = '${remote}'`)

		expect(code).not.toContain(bundled)
		expect(code).toContain("const bundled = 'data:font/woff2;base64,")
		expect(code).toContain(remote)
	})
})
