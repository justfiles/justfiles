export const css = `
.doom-app {
	position: relative;
	width: 100%;
	height: 100%;
	display: grid;
	place-items: center;
	background: #050505;
	color: #f8fafc;
	font-family: system-ui, sans-serif;
	outline: none;
}

.doom-app .screen {
	max-width: 100%;
	max-height: 100%;
	aspect-ratio: 1.6;
	image-rendering: pixelated;
	background: #000;
	outline: none;
}

.doom-app .start {
	position: absolute;
	top: 50%;
	left: 50%;
	min-width: 120px;
	height: 40px;
	transform: translate(-50%, -50%);
	border: 1px solid rgb(255 255 255 / 0.34);
	border-radius: 4px;
	background: rgb(0 0 0 / 0.82);
	color: #f8fafc;
	font: 14px / 1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	cursor: pointer;
}

.doom-app .start:disabled {
	color: #94a3b8;
	cursor: wait;
}

.doom-app .monitor {
	position: absolute;
	left: 8px;
	bottom: 8px;
	padding: 4px 6px;
	background: rgb(0 0 0 / 0.72);
	color: #cbd5e1;
	border: 1px solid rgb(255 255 255 / 0.16);
	border-radius: 4px;
	font: 12px / 1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.doom-app .bindings {
	position: absolute;
	right: 8px;
	bottom: 8px;
	max-width: calc(100% - 16px);
	padding: 4px 6px;
	background: rgb(0 0 0 / 0.72);
	color: #cbd5e1;
	border: 1px solid rgb(255 255 255 / 0.16);
	border-radius: 4px;
	font: 12px / 1.2 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
	text-align: right;
}
`
