import { expect, test } from 'vitest'
import { FRAME_SRCDOC } from './gui-frame.ts'

test('the app frame can load mapped browser packages', () => {
	expect(FRAME_SRCDOC).toContain("script-src 'unsafe-inline' blob: https://esm.sh")
})
