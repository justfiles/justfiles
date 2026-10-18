const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8"?>'
const SVG_ROOT = /<svg(?=\s|>)[^>]*>/i

function escapeXmlText(value: string): string {
	return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function setRootAttribute(root: string, name: string, value: string): string {
	const attribute = new RegExp(`\\s${name}\\s*=\\s*(?:"[^"]*"|'[^']*')`, 'i')
	const serialized = ` ${name}="${value}"`
	return attribute.test(root)
		? root.replace(attribute, serialized)
		: root.replace(/>$/, `${serialized}>`)
}

export function serializeIconSvg(svgMarkup: string, projectName: string): string {
	const match = SVG_ROOT.exec(svgMarkup)
	if (!match) throw new Error('Excalidraw export did not contain an SVG root element')

	const title = projectName.trim() || 'Untitled icon'
	const root = setRootAttribute(
		setRootAttribute(match[0], 'role', 'img'),
		'aria-labelledby',
		'icon-title'
	)
	const titleElement = `<title id="icon-title">${escapeXmlText(title)}</title>`
	const labelledSvg = `${svgMarkup.slice(0, match.index)}${root}${titleElement}${svgMarkup.slice(
		match.index + match[0].length
	)}`

	return `${XML_DECLARATION}\n${labelledSvg}`
}
