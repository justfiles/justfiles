import '@justfiles/app/client'
import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

type Cell = string

type Slot = {
	id: string
	direction: Direction
	row: number
	col: number
	length: number
	pattern: string
}

type Direction = 'across' | 'down'

type Entry = { slotId: string; answer: string; clue: string }

type Play = {
	userGrid: Record<Cell, string>
	revealed: Cell[]
	wrongCells: Cell[]
	startedAt?: number
	finishedAt?: number
	hintsUsed: number
	checksUsed: number
	submitCount: number
}

type Context = {
	theme?: string
	candidates: string[]
	grid?: string[]
	slots: Slot[]
	entries: Record<string, Entry>
	play: Play
}

type Snapshot = { state: string; context: Context }

const cellKey = (r: number, c: number): Cell => `${r},${c}`

const parseCell = (key: Cell): [number, number] => {
	const [r, c] = key.split(',').map(Number)
	return [r ?? 0, c ?? 0]
}

function App() {
	const [view, setView] = useState<Snapshot | null>((window.app.state as Snapshot) ?? null)
	useEffect(() => window.app.subscribe((s) => setView((s as Snapshot) ?? null)), [])

	if (!view)
		return (
			<main>
				<p className="standby">Loading…</p>
			</main>
		)
	const { state, context } = view

	if (state === 'init') {
		return (
			<main>
				<p className="standby">Pick a theme to begin.</p>
			</main>
		)
	}
	if (!context.grid) {
		const msg =
			state === 'themed'
				? `Theme${context.theme ? ` "${context.theme}"` : ''} set. Generating seeds…`
				: 'Building puzzle…'
		return (
			<main>
				<p className="standby">{msg}</p>
			</main>
		)
	}
	return <Game view={view} grid={context.grid} />
}

function Game({ view, grid }: { view: Snapshot; grid: string[] }) {
	const ctx = view.context
	const slots = ctx.slots
	const play = ctx.play
	const isSolved = view.state === 'solved'

	const firstPlay = useMemo<Cell | null>(() => {
		for (let r = 0; r < grid.length; r++) {
			const row = grid[r] ?? ''
			for (let c = 0; c < row.length; c++) {
				if (row[c] !== '#') return cellKey(r, c)
			}
		}
		return null
	}, [grid])

	const [selected, setSelected] = useState<Cell | null>(firstPlay)
	const [direction, setDirection] = useState<Direction>('across')

	const cellNum = useMemo(() => {
		const map: Record<Cell, number> = {}
		let n = 1
		for (let r = 0; r < grid.length; r++) {
			const row = grid[r] ?? ''
			for (let c = 0; c < row.length; c++) {
				if (row[c] === '#') continue
				const startsAcross =
					(c === 0 || row[c - 1] === '#') && c + 1 < row.length && row[c + 1] !== '#'
				const startsDown =
					(r === 0 || (grid[r - 1]?.[c] ?? '#') === '#') &&
					r + 1 < grid.length &&
					(grid[r + 1]?.[c] ?? '#') !== '#'
				if (startsAcross || startsDown) map[cellKey(r, c)] = n++
			}
		}
		return map
	}, [grid])

	const slotByCell = useMemo(() => {
		const a = new Map<Cell, string>()
		const d = new Map<Cell, string>()
		for (const s of slots) {
			for (let i = 0; i < s.length; i++) {
				const r = s.direction === 'down' ? s.row + i : s.row
				const c = s.direction === 'across' ? s.col + i : s.col
				if (s.direction === 'across') a.set(cellKey(r, c), s.id)
				else d.set(cellKey(r, c), s.id)
			}
		}
		return { across: a, down: d }
	}, [slots])

	const directionsFor = useCallback(
		(key: Cell): Direction[] => {
			const dirs: Direction[] = []
			if (slotByCell.across.has(key)) dirs.push('across')
			if (slotByCell.down.has(key)) dirs.push('down')
			return dirs
		},
		[slotByCell]
	)

	const pickDirection = useCallback(
		(key: Cell, preferred: Direction): Direction => {
			const dirs = directionsFor(key)
			if (dirs.includes(preferred)) return preferred
			return dirs[0] ?? preferred
		},
		[directionsFor]
	)

	const selectCell = useCallback(
		(key: Cell, preferred: Direction) => {
			setSelected(key)
			setDirection(pickDirection(key, preferred))
		},
		[pickDirection]
	)

	const toggleDirection = useCallback(() => {
		if (!selected) return
		const dirs = directionsFor(selected)
		if (dirs.length < 2) {
			setDirection(dirs[0] ?? direction)
			return
		}
		setDirection((d) => (d === 'across' ? 'down' : 'across'))
	}, [selected, directionsFor, direction])

	const activeSlotId = selected
		? direction === 'across'
			? slotByCell.across.get(selected)
			: slotByCell.down.get(selected)
		: undefined
	const activeSlot = slots.find((s) => s.id === activeSlotId)

	const activeSlotCells = useMemo(() => {
		const out = new Set<Cell>()
		if (!activeSlot) return out
		for (let i = 0; i < activeSlot.length; i++) {
			const r = activeSlot.direction === 'down' ? activeSlot.row + i : activeSlot.row
			const c = activeSlot.direction === 'across' ? activeSlot.col + i : activeSlot.col
			out.add(cellKey(r, c))
		}
		return out
	}, [activeSlot])

	const revealedSet = useMemo(() => new Set(play.revealed), [play.revealed])
	const wrongSet = useMemo(() => new Set(play.wrongCells), [play.wrongCells])

	const moveSelection = useCallback(
		(dr: number, dc: number, nextDirection: Direction) => {
			if (!selected) return false
			const [r, c] = parseCell(selected)
			let nr = r + dr
			let nc = c + dc
			while (nr >= 0 && nr < grid.length && nc >= 0 && nc < (grid[nr]?.length ?? 0)) {
				if (grid[nr]?.[nc] !== '#') {
					selectCell(cellKey(nr, nc), nextDirection)
					return true
				}
				nr += dr
				nc += dc
			}
			setDirection(pickDirection(selected, nextDirection))
			return false
		},
		[selected, grid, selectCell, pickDirection]
	)

	const advance = useCallback(() => {
		if (!activeSlot || !selected) return
		const [r, c] = parseCell(selected)
		const i = activeSlot.direction === 'across' ? c - activeSlot.col : r - activeSlot.row
		if (i + 1 >= activeSlot.length) return
		const nr = activeSlot.direction === 'down' ? r + 1 : r
		const nc = activeSlot.direction === 'across' ? c + 1 : c
		setSelected(cellKey(nr, nc))
	}, [activeSlot, selected])

	const retreat = useCallback(() => {
		if (!activeSlot || !selected) return
		const [r, c] = parseCell(selected)
		const i = activeSlot.direction === 'across' ? c - activeSlot.col : r - activeSlot.row
		if (i === 0) return
		const nr = activeSlot.direction === 'down' ? r - 1 : r
		const nc = activeSlot.direction === 'across' ? c - 1 : c
		setSelected(cellKey(nr, nc))
	}, [activeSlot, selected])

	useEffect(() => {
		if (isSolved) return
		const handler = (e: KeyboardEvent) => {
			if (!selected) return
			const [r, c] = parseCell(selected)
			if (e.key === 'ArrowLeft') {
				e.preventDefault()
				moveSelection(0, -1, 'across')
				return
			}
			if (e.key === 'ArrowRight') {
				e.preventDefault()
				moveSelection(0, 1, 'across')
				return
			}
			if (e.key === 'ArrowUp') {
				e.preventDefault()
				moveSelection(-1, 0, 'down')
				return
			}
			if (e.key === 'ArrowDown') {
				e.preventDefault()
				moveSelection(1, 0, 'down')
				return
			}
			if (e.key === 'Tab' || e.key === ' ') {
				e.preventDefault()
				toggleDirection()
				return
			}
			if (e.key === 'Backspace') {
				e.preventDefault()
				if (revealedSet.has(selected)) {
					retreat()
					return
				}
				if (play.userGrid[selected]) {
					void window.app.dispatch({
						type: 'enterLetter',
						payload: { row: r, col: c, letter: '' }
					})
				} else {
					retreat()
				}
				return
			}
			if (/^[a-zA-Z]$/.test(e.key)) {
				e.preventDefault()
				if (revealedSet.has(selected)) {
					advance()
					return
				}
				void window.app.dispatch({
					type: 'enterLetter',
					payload: { row: r, col: c, letter: e.key.toUpperCase() }
				})
				advance()
			}
		}
		window.addEventListener('keydown', handler)
		return () => window.removeEventListener('keydown', handler)
	}, [
		selected,
		isSolved,
		moveSelection,
		toggleDirection,
		retreat,
		advance,
		revealedSet,
		play.userGrid
	])

	const dispatch = (type: string, payload: object = {}) => window.app.dispatch({ type, payload })

	const onCellClick = (r: number, c: number) => {
		if (grid[r]?.[c] === '#') return
		const key = cellKey(r, c)
		if (selected === key) toggleDirection()
		else selectCell(key, direction)
	}

	const width = grid[0]?.length ?? 0

	return (
		<main className="crossword">
			<section className="puzzle">
				<header className="hud">
					<h1 className="theme">{ctx.theme ?? 'Crossword'}</h1>
					<Stats play={play} solved={isSolved} />
				</header>
				<div className="grid" style={{ gridTemplateColumns: `repeat(${width}, 1fr)` }}>
					{grid.flatMap((row, r) =>
						row.split('').map((ch, c) => {
							const key = cellKey(r, c)
							const isBlock = ch === '#'
							const isSelected = selected === key
							const inSlot = activeSlotCells.has(key)
							const isRevealed = revealedSet.has(key)
							const isWrong = wrongSet.has(key)
							const letter = play.userGrid[key]
							const cls = [
								'cell',
								isBlock && 'block',
								isSelected && 'selected',
								!isSelected && inSlot && 'in-slot',
								isRevealed && 'revealed',
								isWrong && 'wrong'
							]
								.filter(Boolean)
								.join(' ')
							const children = (
								<>
									{!isBlock && cellNum[key] !== undefined && (
										<span className="num">{cellNum[key]}</span>
									)}
									{!isBlock && letter && <span className="letter">{letter}</span>}
								</>
							)
							if (isBlock)
								return (
									<div key={key} className={cls}>
										{children}
									</div>
								)
							return (
								<button type="button" key={key} className={cls} onClick={() => onCellClick(r, c)}>
									{children}
								</button>
							)
						})
					)}
				</div>
				{isSolved ? (
					<div className="result">
						<h2>Solved.</h2>
					</div>
				) : (
					<div className="toolbar">
						<fieldset>
							<legend>Reveal</legend>
							<button
								type="button"
								disabled={!selected}
								onClick={() => {
									if (!selected) return
									const [r, c] = parseCell(selected)
									void dispatch('revealLetter', { row: r, col: c })
								}}
							>
								Letter
							</button>
							<button
								type="button"
								disabled={!activeSlot}
								onClick={() => activeSlot && dispatch('revealWord', { slotId: activeSlot.id })}
							>
								Word
							</button>
							<button
								type="button"
								onClick={() => {
									if (window.confirm('Reveal the entire puzzle?')) void dispatch('revealPuzzle')
								}}
							>
								Puzzle
							</button>
						</fieldset>
						<fieldset>
							<legend>Check</legend>
							<button
								type="button"
								disabled={!selected}
								onClick={() => {
									if (!selected) return
									const [r, c] = parseCell(selected)
									void dispatch('checkLetter', { row: r, col: c })
								}}
							>
								Letter
							</button>
							<button
								type="button"
								disabled={!activeSlot}
								onClick={() => activeSlot && dispatch('checkWord', { slotId: activeSlot.id })}
							>
								Word
							</button>
							<button type="button" onClick={() => dispatch('checkPuzzle')}>
								Puzzle
							</button>
						</fieldset>
						<fieldset>
							<legend>Game</legend>
							<button type="button" onClick={() => dispatch('submit')}>
								Submit
							</button>
							<button
								type="button"
								onClick={() => {
									if (window.confirm('Wipe entered letters?')) void dispatch('reset')
								}}
							>
								Reset
							</button>
						</fieldset>
					</div>
				)}
			</section>
			<aside className="clues">
				<ClueList
					title="Across"
					slots={slots.filter((s) => s.direction === 'across')}
					entries={ctx.entries}
					activeSlotId={direction === 'across' ? activeSlotId : undefined}
					cellNum={cellNum}
					onSelect={(s) => {
						setSelected(cellKey(s.row, s.col))
						setDirection('across')
					}}
				/>
				<ClueList
					title="Down"
					slots={slots.filter((s) => s.direction === 'down')}
					entries={ctx.entries}
					activeSlotId={direction === 'down' ? activeSlotId : undefined}
					cellNum={cellNum}
					onSelect={(s) => {
						setSelected(cellKey(s.row, s.col))
						setDirection('down')
					}}
				/>
			</aside>
		</main>
	)
}

function ClueList({
	title,
	slots,
	entries,
	activeSlotId,
	onSelect,
	cellNum
}: {
	title: string
	slots: Slot[]
	entries: Record<string, Entry>
	activeSlotId?: string
	onSelect: (s: Slot) => void
	cellNum: Record<Cell, number>
}) {
	return (
		<div>
			<h2>{title}</h2>
			<ol className="clue-list">
				{slots.map((s) => {
					const num = cellNum[cellKey(s.row, s.col)]
					const clue = entries[s.id]?.clue ?? ''
					const active = s.id === activeSlotId
					return (
						<li key={s.id}>
							<button
								type="button"
								className={`clue${active ? ' active' : ''}`}
								onClick={() => onSelect(s)}
							>
								<span className="clue-num">{num ?? s.id}</span>
								<span>{clue}</span>
							</button>
						</li>
					)
				})}
			</ol>
		</div>
	)
}

function Stats({ play, solved }: { play: Play; solved: boolean }) {
	const [now, setNow] = useState(Date.now())
	useEffect(() => {
		if (solved) return
		const id = setInterval(() => setNow(Date.now()), 1000)
		return () => clearInterval(id)
	}, [solved])
	const start = play.startedAt ?? now
	const end = play.finishedAt ?? now
	const elapsed = Math.max(0, Math.floor((end - start) / 1000))
	const mins = Math.floor(elapsed / 60)
	const secs = elapsed % 60
	return (
		<dl className="stats">
			<div>
				<dt>Time</dt>
				<dd>
					{mins}:{String(secs).padStart(2, '0')}
				</dd>
			</div>
			<div>
				<dt>Hints</dt>
				<dd>{play.hintsUsed}</dd>
			</div>
			<div>
				<dt>Submits</dt>
				<dd>{play.submitCount}</dd>
			</div>
		</dl>
	)
}

const root = document.getElementById('root')
if (root)
	createRoot(root).render(
		<StrictMode>
			<App />
		</StrictMode>
	)
