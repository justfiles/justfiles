export const css = `
.crossword-app {
	box-sizing: border-box;
	min-height: 100%;
	display: flex;
	align-items: center;
	justify-content: center;
	font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
	color: #e0f2fe;
	background: radial-gradient(circle at top, #164e63, #020617 62%);
}
.crossword-app main {
	box-sizing: border-box;
	width: min(1120px, 100%);
	padding: 24px;
}
.crossword-app .standby,
.crossword-app .error {
	margin: 0;
	padding: 16px 24px;
	border: 2px dashed #475569;
	color: #94a3b8;
	font-size: 14px;
	letter-spacing: 0.05em;
}
.crossword-app .error {
	border-color: #ef4444;
	color: #fecaca;
}
.crossword-app .briefing {
	white-space: pre-wrap;
	letter-spacing: 0;
}
.crossword-app .setup {
	display: grid;
	gap: 12px;
	max-width: 480px;
}
.crossword-app .setup h1 {
	margin: 0;
	color: #bae6fd;
	letter-spacing: 0.12em;
	text-transform: uppercase;
}
.crossword-app .setup input,
.crossword-app .setup button,
.crossword-app .toolbar button {
	font: inherit;
	color: #e0f2fe;
	background: #0f172a;
}
.crossword-app .setup input {
	padding: 10px 12px;
	border: 1px solid #475569;
	border-radius: 4px;
}
.crossword-app .setup button {
	padding: 10px 12px;
	border: 1px solid #7dd3fc;
	border-radius: 4px;
	cursor: pointer;
}
.crossword-app button:disabled {
	opacity: 0.4;
	cursor: not-allowed;
}
.crossword-app .crossword {
	display: grid;
	grid-template-columns: minmax(280px, 600px) minmax(240px, 1fr);
	gap: 24px;
	align-items: start;
}
.crossword-app .puzzle {
	display: grid;
	gap: 12px;
}
.crossword-app .grid {
	display: grid;
	gap: 2px;
	padding: 2px;
	background: #1e293b;
	border: 2px solid #7dd3fc;
	width: 100%;
	aspect-ratio: 1 / 1;
}
.crossword-app .cell {
	position: relative;
	box-sizing: border-box;
	border: 0;
	padding: 0;
	background: #f8fafc;
	font: inherit;
	cursor: pointer;
	appearance: none;
}
.crossword-app .cell.block {
	background: #020617;
	cursor: default;
}
.crossword-app .cell.in-slot {
	background: #cffafe;
}
.crossword-app .cell.selected {
	background: #fde68a;
	outline: 2px solid #f59e0b;
	outline-offset: -2px;
	z-index: 1;
}
.crossword-app .cell.wrong .letter {
	color: #dc2626;
	text-decoration: line-through;
}
.crossword-app .cell.revealed .letter {
	color: #2563eb;
}
.crossword-app .num {
	position: absolute;
	top: 1px;
	left: 2px;
	font-size: 9px;
	color: #334155;
	line-height: 1;
}
.crossword-app .letter {
	position: absolute;
	inset: 0;
	display: grid;
	place-items: center;
	font-size: clamp(14px, 3.2vmin, 28px);
	font-weight: 700;
	color: #0f172a;
}
.crossword-app .clues {
	display: grid;
	gap: 20px;
	min-width: 0;
	max-height: min(600px, calc(100vh - 48px));
	overflow: auto;
}
.crossword-app .clues h2 {
	margin: 0 0 8px;
	color: #bae6fd;
	font-size: 13px;
	font-weight: 700;
	text-transform: uppercase;
	letter-spacing: 0.12em;
}
.crossword-app .clue-list {
	display: grid;
	gap: 8px;
	margin: 0;
	padding: 0;
	list-style: none;
}
.crossword-app .clue {
	display: grid;
	grid-template-columns: 32px 1fr;
	gap: 10px;
	align-items: start;
	width: 100%;
	border: 0;
	color: #e0f2fe;
	background: transparent;
	font: inherit;
	font-size: 14px;
	line-height: 1.35;
	text-align: left;
	cursor: pointer;
	padding: 4px 6px;
	border-radius: 4px;
	appearance: none;
}
.crossword-app .clue:hover {
	background: rgba(125, 211, 252, 0.08);
}
.crossword-app .clue.active {
	background: rgba(125, 211, 252, 0.18);
}
.crossword-app .clue-num {
	color: #7dd3fc;
	font-weight: 700;
	text-align: right;
}
.crossword-app .hud {
	display: flex;
	align-items: baseline;
	justify-content: space-between;
	gap: 16px;
	flex-wrap: wrap;
}
.crossword-app .theme {
	margin: 0;
	font-size: 18px;
	color: #bae6fd;
	text-transform: uppercase;
	letter-spacing: 0.12em;
}
.crossword-app .toolbar {
	display: flex;
	gap: 8px;
	flex-wrap: wrap;
}
.crossword-app .toolbar button {
	padding: 6px 10px;
	border: 1px solid #475569;
	font-size: 12px;
	cursor: pointer;
	border-radius: 3px;
}
.crossword-app .toolbar button:hover:not(:disabled) {
	background: #164e63;
}
.crossword-app .result {
	padding: 16px 20px;
	border: 2px solid #34d399;
	border-radius: 6px;
	background: rgba(52, 211, 153, 0.1);
}
.crossword-app .result h2 {
	margin: 0;
	color: #6ee7b7;
}
@media (max-width: 760px) {
	.crossword-app {
		align-items: start;
	}
	.crossword-app .crossword {
		grid-template-columns: 1fr;
	}
	.crossword-app .clues {
		max-height: none;
	}
}
`
