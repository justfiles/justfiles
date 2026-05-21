import { type Client, defineGUI } from '@justfiles/app/kernel/sdk'
import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { type CrosswordApp, type CrosswordState, type Entry, initialState } from './app'
import { type Cell, cellKey, type Direction, type Slot } from './puzzle.ts'
import { css } from './style'

const parseCell = (key: Cell): [number, number] => {
	const [r, c] = key.split(',').map(Number)
	return [r ?? 0, c ?? 0]
}

const stateOrInitial = (value: unknown): CrosswordState =>
	value && typeof value === 'object' && 'phase' in value ? (value as CrosswordState) : initialState

const cellNumbers = (grid: string[]): Record<Cell, number> => {
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
}

export const gui = defineGUI<CrosswordApp>({
	mount(el, state, ctx) {
		const style = document.createElement('style')
		style.textContent = css
		document.head.append(style)

		const root = createRoot(el)
		const render = (next: CrosswordState | null) =>
			root.render(
				<StrictMode>
					<Crossword state={stateOrInitial(next)} client={ctx.client} />
				</StrictMode>
			)
		render(state)

		return {
			update: render,
			unmount() {
				root.unmount()
				style.remove()
			}
		}
	}
})

function Crossword({ state, client }: { state: CrosswordState; client: Client<CrosswordApp> }) {
	const [theme, setTheme] = useState(state.theme)
	const [error, setError] = useState<string | null>(null)
	const call = useCallback((promise: Promise<unknown>) => {
		setError(null)
		void promise.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
	}, [])

	if (state.phase === 'idle')
		return (
			<div className="crossword-app">
				<main>
					<section className="setup">
						<h1>Crossword</h1>
						<p>Pick a theme. The agent fills the grid; you solve it.</p>
						<input
							value={theme}
							onChange={(e) => setTheme(e.target.value)}
							placeholder="e.g. space, harry potter, jazz"
						/>
						<button
							type="button"
							onClick={() => call(client.start({ theme }))}
							disabled={!theme.trim()}
						>
							Start
						</button>
						{error && <p className="error">{error}</p>}
					</section>
				</main>
			</div>
		)

	if (state.phase === 'awaiting-seeds' || !state.puzzle)
		return (
			<div className="crossword-app">
				<main>
					<p className="standby">
						Theme "{state.theme}". Waiting for the agent to submit seed words…
					</p>
					{state.briefing && <pre className="standby briefing">{state.briefing}</pre>}
					{error && <p className="error">{error}</p>}
				</main>
			</div>
		)

	if (state.phase === 'awaiting-fill')
		return (
			<div className="crossword-app">
				<main>
					<p className="standby">
						Theme "{state.puzzle.theme}". Waiting for the agent to write clues for{' '}
						{state.puzzle.slots.length} slot(s)…
					</p>
					{state.briefing && <pre className="standby briefing">{state.briefing}</pre>}
					{error && <p className="error">{error}</p>}
				</main>
			</div>
		)

	return (
		<div className="crossword-app">
			<Game
				puzzle={state.puzzle}
				solved={state.phase === 'solved'}
				userGrid={state.userGrid}
				revealed={new Set(state.revealed)}
				wrong={new Set(state.wrong)}
				onEnter={(row, col, letter) => call(client.enter({ row, col, letter }))}
				onReveal={(cells) => call(client.reveal({ cells }))}
				onCheck={(cells) => call(client.check({ cells }))}
			/>
			{error && <p className="error">{error}</p>}
		</div>
	)
}

type GameProps = {
	puzzle: NonNullable<CrosswordState['puzzle']>
	solved: boolean
	userGrid: Record<Cell, string>
	revealed: Set<Cell>
	wrong: Set<Cell>
	onEnter: (r: number, c: number, letter: string) => void
	onReveal: (cells: Cell[]) => void
	onCheck: (cells: Cell[]) => void
}

function Game({
	puzzle,
	solved,
	userGrid,
	revealed,
	wrong,
	onEnter,
	onReveal,
	onCheck
}: GameProps) {
	const { grid, slots } = puzzle

	const firstPlay = useMemo<Cell | null>(() => {
		for (let r = 0; r < grid.length; r++) {
			const row = grid[r] ?? ''
			for (let c = 0; c < row.length; c++) if (row[c] !== '#') return cellKey(r, c)
		}
		return null
	}, [grid])

	const [selected, setSelected] = useState<Cell | null>(firstPlay)
	const [direction, setDirection] = useState<Direction>('across')
	useEffect(() => setSelected(firstPlay), [firstPlay])

	const cellNum = useMemo(() => cellNumbers(grid), [grid])

	const slotByCell = useMemo(() => {
		const across = new Map<Cell, string>()
		const down = new Map<Cell, string>()
		for (const s of slots) {
			for (let i = 0; i < s.length; i++) {
				const r = s.direction === 'down' ? s.row + i : s.row
				const c = s.direction === 'across' ? s.col + i : s.col
				;(s.direction === 'across' ? across : down).set(cellKey(r, c), s.id)
			}
		}
		return { across, down }
	}, [slots])

	const slotCells = useCallback((slot: Slot): Cell[] => {
		const out: Cell[] = []
		for (let i = 0; i < slot.length; i++) {
			const r = slot.direction === 'down' ? slot.row + i : slot.row
			const c = slot.direction === 'across' ? slot.col + i : slot.col
			out.push(cellKey(r, c))
		}
		return out
	}, [])

	const allPlayCells = useMemo(() => {
		const out: Cell[] = []
		for (let r = 0; r < grid.length; r++) {
			const row = grid[r] ?? ''
			for (let c = 0; c < row.length; c++) if (row[c] !== '#') out.push(cellKey(r, c))
		}
		return out
	}, [grid])

	const activeSlotId = selected
		? direction === 'across'
			? slotByCell.across.get(selected)
			: slotByCell.down.get(selected)
		: undefined
	const activeSlot = slots.find((s) => s.id === activeSlotId)
	const activeSlotCells = useMemo(
		() => new Set(activeSlot ? slotCells(activeSlot) : []),
		[activeSlot, slotCells]
	)

	const directionsFor = useCallback(
		(key: Cell): Direction[] => {
			const dirs: Direction[] = []
			if (slotByCell.across.has(key)) dirs.push('across')
			if (slotByCell.down.has(key)) dirs.push('down')
			return dirs
		},
		[slotByCell]
	)

	const advance = useCallback(() => {
		if (!activeSlot || !selected) return
		const [r, c] = parseCell(selected)
		const i = activeSlot.direction === 'across' ? c - activeSlot.col : r - activeSlot.row
		if (i + 1 >= activeSlot.length) return
		setSelected(
			cellKey(
				activeSlot.direction === 'down' ? r + 1 : r,
				activeSlot.direction === 'across' ? c + 1 : c
			)
		)
	}, [activeSlot, selected])

	const retreat = useCallback(() => {
		if (!activeSlot || !selected) return
		const [r, c] = parseCell(selected)
		const i = activeSlot.direction === 'across' ? c - activeSlot.col : r - activeSlot.row
		if (i === 0) return
		setSelected(
			cellKey(
				activeSlot.direction === 'down' ? r - 1 : r,
				activeSlot.direction === 'across' ? c - 1 : c
			)
		)
	}, [activeSlot, selected])

	const moveSelection = useCallback(
		(dr: number, dc: number, nextDir: Direction) => {
			if (!selected) return
			const [r, c] = parseCell(selected)
			let nr = r + dr
			let nc = c + dc
			while (nr >= 0 && nr < grid.length && nc >= 0 && nc < (grid[nr]?.length ?? 0)) {
				if (grid[nr]?.[nc] !== '#') {
					setSelected(cellKey(nr, nc))
					setDirection((d) => (directionsFor(cellKey(nr, nc)).includes(nextDir) ? nextDir : d))
					return
				}
				nr += dr
				nc += dc
			}
		},
		[selected, grid, directionsFor]
	)

	useEffect(() => {
		if (solved) return
		const handler = (e: KeyboardEvent) => {
			if (!selected) return
			const arrow: [number, number, Direction] | null =
				e.key === 'ArrowLeft'
					? [0, -1, 'across']
					: e.key === 'ArrowRight'
						? [0, 1, 'across']
						: e.key === 'ArrowUp'
							? [-1, 0, 'down']
							: e.key === 'ArrowDown'
								? [1, 0, 'down']
								: null
			if (arrow) {
				e.preventDefault()
				moveSelection(...arrow)
				return
			}
			if (e.key === 'Tab' || e.key === ' ') {
				e.preventDefault()
				const dirs = directionsFor(selected)
				if (dirs.length > 1) setDirection((d) => (d === 'across' ? 'down' : 'across'))
				return
			}
			const [r, c] = parseCell(selected)
			if (e.key === 'Backspace') {
				e.preventDefault()
				if (revealed.has(selected)) return retreat()
				if (userGrid[selected]) onEnter(r, c, '')
				else retreat()
				return
			}
			if (/^[a-zA-Z]$/.test(e.key)) {
				e.preventDefault()
				if (!revealed.has(selected)) onEnter(r, c, e.key.toUpperCase())
				advance()
			}
		}
		window.addEventListener('keydown', handler)
		return () => window.removeEventListener('keydown', handler)
	}, [
		selected,
		solved,
		moveSelection,
		directionsFor,
		revealed,
		userGrid,
		retreat,
		advance,
		onEnter
	])

	const onCellClick = (r: number, c: number) => {
		if (grid[r]?.[c] === '#') return
		const key = cellKey(r, c)
		if (selected === key) {
			const dirs = directionsFor(key)
			if (dirs.length > 1) setDirection((d) => (d === 'across' ? 'down' : 'across'))
			return
		}
		setSelected(key)
		const dirs = directionsFor(key)
		if (!dirs.includes(direction) && dirs[0]) setDirection(dirs[0])
	}

	const width = grid[0]?.length ?? 0

	return (
		<main className="crossword">
			<section className="puzzle">
				<header className="hud">
					<h1 className="theme">{puzzle.theme}</h1>
				</header>
				<div className="grid" style={{ gridTemplateColumns: `repeat(${width}, 1fr)` }}>
					{grid.flatMap((row, r) =>
						row.split('').map((ch, c) => {
							const key = cellKey(r, c)
							const isBlock = ch === '#'
							const cls = [
								'cell',
								isBlock && 'block',
								selected === key && 'selected',
								selected !== key && activeSlotCells.has(key) && 'in-slot',
								revealed.has(key) && 'revealed',
								wrong.has(key) && 'wrong'
							]
								.filter(Boolean)
								.join(' ')
							const letter = userGrid[key]
							const inner = (
								<>
									{!isBlock && cellNum[key] !== undefined && (
										<span className="num">{cellNum[key]}</span>
									)}
									{!isBlock && letter && <span className="letter">{letter}</span>}
								</>
							)
							return isBlock ? (
								<div key={key} className={cls}>
									{inner}
								</div>
							) : (
								<button type="button" key={key} className={cls} onClick={() => onCellClick(r, c)}>
									{inner}
								</button>
							)
						})
					)}
				</div>
				{solved ? (
					<div className="result">
						<h2>Solved.</h2>
					</div>
				) : (
					<div className="toolbar">
						<button
							type="button"
							disabled={!selected}
							onClick={() => selected && onReveal([selected])}
						>
							Reveal letter
						</button>
						<button
							type="button"
							disabled={!activeSlot}
							onClick={() => activeSlot && onReveal(slotCells(activeSlot))}
						>
							Reveal word
						</button>
						<button
							type="button"
							disabled={!selected}
							onClick={() => selected && onCheck([selected])}
						>
							Check letter
						</button>
						<button type="button" onClick={() => onCheck(allPlayCells)}>
							Check puzzle
						</button>
					</div>
				)}
			</section>
			<aside className="clues">
				{(['across', 'down'] as const).map((dir) => (
					<ClueList
						key={dir}
						title={dir === 'across' ? 'Across' : 'Down'}
						slots={slots.filter((s) => s.direction === dir)}
						entries={puzzle.entries}
						activeSlotId={direction === dir ? activeSlotId : undefined}
						cellNum={cellNum}
						onSelect={(s) => {
							setSelected(cellKey(s.row, s.col))
							setDirection(dir)
						}}
					/>
				))}
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
					return (
						<li key={s.id}>
							<button
								type="button"
								className={`clue${s.id === activeSlotId ? ' active' : ''}`}
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
