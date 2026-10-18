import { describe, expect, it } from 'vitest'
import { serializeIconSvg } from './svg-export.ts'

describe('SVG export', () => {
	it('adds an accessible project title to Excalidraw SVG output', () => {
		const output = serializeIconSvg(
			'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024"><rect /></svg>',
			'Rock & Roll <Icon>'
		)

		expect(output).toContain('<?xml version="1.0" encoding="UTF-8"?>')
		expect(output).toContain('role="img"')
		expect(output).toContain('aria-labelledby="icon-title"')
		expect(output).toContain('<title id="icon-title">Rock &amp; Roll &lt;Icon&gt;</title>')
		expect(output).toContain('<rect />')
	})

	it('rejects content that is not an SVG document', () => {
		expect(() => serializeIconSvg('<div />', 'Icon')).toThrow('SVG root element')
	})
})
