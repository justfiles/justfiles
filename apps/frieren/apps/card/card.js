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
		background: radial-gradient(circle at top, #1e1b4b, #020617 62%);
		color: #e0f2fe;
	}
	.card-app {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 16px;
		padding: 24px;
	}
	.eyebrow {
		border: 1px solid #7dd3fc;
		color: #bae6fd;
		font-size: 10px;
		letter-spacing: 0.24em;
		text-transform: uppercase;
		padding: 2px 8px;
		background: rgb(2 6 23 / 0.9);
	}
	.card-face {
		width: 96px;
		height: 128px;
		border: 4px double #7dd3fc;
		background: #0f172a;
		display: grid;
		place-items: center;
		font-size: 32px;
		font-weight: 800;
		color: #fcd34d;
		box-shadow: 4px 4px 0 rgb(0 0 0 / 0.45);
	}
	.status {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
		font-size: 12px;
	}
	.status .others {
		color: rgb(125 211 252 / 0.8);
	}
	form.guess {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	input[type="number"] {
		height: 32px;
		width: 96px;
		text-align: center;
		border: 1px solid #7dd3fc;
		background: #0f172a;
		color: #e0f2fe;
		font: inherit;
	}
	button {
		border: 1px solid #7dd3fc;
		background: #0f172a;
		color: #bae6fd;
		padding: 4px 12px;
		font: inherit;
		cursor: pointer;
		height: 32px;
	}
	button.reveal {
		border-color: #fcd34d;
		color: #fde68a;
	}
	button:hover {
		border-color: #fcd34d;
		color: #fcd34d;
	}
	.outcome {
		text-align: center;
		font-size: 13px;
	}
	.outcome .winner {
		font-weight: 600;
		color: #fcd34d;
	}
`
document.head.append(style)

const root = document.querySelector('#root')

function render(state) {
	const faceText = state.phase === 'revealed' && state.card !== null ? String(state.card) : '?'
	const otherEntries = Object.entries(state.otherGuesses)
	const totalGuesses = otherEntries.length + (state.myGuess !== null ? 1 : 0)
	const showGuess = state.phase === 'guessing' && state.myGuess === null
	const showReveal = state.phase === 'guessing' && totalGuesses >= 2
	const showOutcome = state.phase === 'revealed'

	root.className = 'card-app'
	root.innerHTML = `
		<div class="eyebrow">Card Guessing</div>
		<div class="card-face">${faceText}</div>
		<div class="status">
			<div>Your guess: ${state.myGuess ?? '—'}</div>
			${
				otherEntries.length > 0
					? `<div class="others">Others: ${otherEntries
							.map(([id, g]) => `${id}=${g === 'submitted' ? '?' : g}`)
							.join(', ')}</div>`
					: ''
			}
		</div>
		${
			showGuess
				? `<form class="guess">
						<input type="number" min="1" max="100" placeholder="1-100" name="value" />
						<button type="submit">Guess</button>
					</form>`
				: ''
		}
		${showReveal ? '<button type="button" class="reveal">Reveal</button>' : ''}
		${
			showOutcome
				? `<div class="outcome">
						<div>Card was ${state.card}.</div>
						<div class="winner">Winner: ${state.winner ?? 'nobody'}</div>
					</div>`
				: ''
		}
	`

	const form = root.querySelector('form.guess')
	if (form) {
		form.addEventListener('submit', (event) => {
			event.preventDefault()
			const input = form.querySelector('input[name="value"]')
			const value = Number.parseInt(input.value, 10)
			if (!Number.isFinite(value) || value < 1 || value > 100) return
			void window.app.dispatch({ type: 'guess', payload: { value } })
		})
	}

	const reveal = root.querySelector('button.reveal')
	if (reveal) {
		reveal.addEventListener('click', () => {
			void window.app.dispatch({ type: 'reveal', payload: {} })
		})
	}
}

window.app.subscribe(render)
