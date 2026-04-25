const style = document.createElement('style')
style.textContent = `
	:root {
		color-scheme: dark;
		font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
	}
	body {
		margin: 0;
		min-height: 100vh;
		display: grid;
		place-items: center;
		background: radial-gradient(circle at top, #164e63, #020617 62%);
		color: #e0f2fe;
	}
	.counter {
		display: grid;
		gap: 16px;
		justify-items: center;
		padding: 32px;
		border: 4px double #7dd3fc;
		background: rgb(15 23 42 / 0.86);
		box-shadow: 8px 8px 0 rgb(0 0 0 / 0.38);
	}
	.eyebrow {
		margin: 0;
		color: #bae6fd;
		font-size: 11px;
		letter-spacing: 0.24em;
		text-transform: uppercase;
	}
	h1 {
		margin: 0;
		font-size: 24px;
	}
	output {
		font-size: 72px;
		font-weight: 800;
		color: #fcd34d;
	}
	.actions {
		display: flex;
		gap: 8px;
	}
	button {
		border: 2px solid #7dd3fc;
		background: #020617;
		color: #e0f2fe;
		padding: 8px 12px;
		font: inherit;
		cursor: pointer;
	}
	button:hover {
		border-color: #fcd34d;
		color: #fcd34d;
	}
`
document.head.append(style)

const count = document.querySelector('#count')

window.app.subscribe((state) => {
	count.textContent = String(state.count ?? 0)
})

for (const button of document.querySelectorAll('[data-action]')) {
	button.addEventListener('click', () => {
		void window.app.dispatch({ type: button.dataset.action, payload: {} })
	})
}
