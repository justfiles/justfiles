import { guiFrameScript } from '@justfiles/app/iframe'
import macCss from '@justfiles/design/mac.css?inline'

// This CSP blocks normal request paths. It is not total egress isolation because
// `connect-src` does not control WebRTC. Never send credentials or host handles
// to the GUI, and treat all state and capability results as publisher-visible.
const CSP = [
	"default-src 'none'",
	"script-src 'unsafe-inline' blob:",
	"style-src 'unsafe-inline'",
	'img-src data: blob:',
	'font-src data: https://esm.sh',
	'media-src data: blob:',
	"connect-src 'none'",
	"form-action 'none'",
	"frame-src 'none'",
	"child-src 'none'",
	"object-src 'none'",
	"base-uri 'none'"
].join('; ')

export const FRAME_SRCDOC = `<!doctype html><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<style>${macCss}</style>
<style>html,body{margin:0;height:100%}#root{height:100%;overflow:hidden}</style>
<div id="root"></div>
<script>${guiFrameScript}</script>`
