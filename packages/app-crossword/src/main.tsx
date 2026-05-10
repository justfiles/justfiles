import { StrictMode, useCallback, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import './style.css'
import {
	bakeAnswers,
	buildPuzzle,
	type Cell,
	cellKey,
	type Direction,
	patternMatches,
	type Slot
} from './puzzle.ts'

const SIZE = 11

type Entry = { slotId: string; answer: string; clue: string }

type Puzzle = {
	theme: string
	grid: string[]
	slots: Slot[]
	entries: Record<string, Entry>
}

type Phase = 'idle' | 'awaiting-seeds' | 'awaiting-fill' | 'playing' | 'solved'

const parseCell = (key: Cell): [number, number] => {
	const [r, c] = key.split(',').map(Number)
	return [r ?? 0, c ?? 0]
}

const upper = (s: string) => s.toUpperCase().replace(/[^A-Z]/g, '')

const seedsBriefing = (theme: string, slotMsg: string) =>
	[
		`Theme: "${theme}".`,
		'You are the crossword constructor. Pick 8-12 themed single-word answers (uppercase A-Z, 3-8 letters, no abbreviations or fragments).',
		'Spread across people, places, objects, concepts, and deep cuts. Avoid only obvious picks.',
		'Do not reveal answers in chat — pass them only as tool arguments.',
		'Step 1: call the seeds tool with { words: [...] }.',
		slotMsg
	].join(' ')

const fillBriefing = (slots: Slot[]) =>
	[
		`Step 2: for each of the ${slots.length} slots below, pick a thematic answer matching the pattern (? = any letter) and write a clue. Never include the answer in its clue.`,
		'Slots:',
		slots.map((s) => `  ${s.id} ${s.direction} ${s.pattern}`).join('\n'),
		'Call the fill tool with { entries: [{ slotId, answer, clue }, ...] }. If no real word fits a pattern, ask the user to pick a different theme.'
	].join('\n')

function App() {
	const [phase, setPhase] = useState<Phase>('idle')
	const [puzzle, setPuzzle] = useState<Puzzle | null>(null)
	const [theme, setTheme] = useState('')
	const [error, setError] = useState<string | null>(null)
	const [userGrid, setUserGrid] = useState<Record<Cell, string>>({})
	const [revealed, setRevealed] = useState<Set<Cell>>(new Set())
	const [wrong, setWrong] = useState<Set<Cell>>(new Set())

	const grid = puzzle?.grid

	useEffect(() => {
		if (!grid || phase !== 'playing') return
		for (let r = 0; r < grid.length; r++) {
			const row = grid[r] ?? ''
			for (let c = 0; c < row.length; c++) {
				if (row[c] === '#') continue
				if (userGrid[cellKey(r, c)] !== row[c]) return
			}
		}
		setPhase('solved')
	}, [grid, userGrid, phase])

	useEffect(() => {
		const a = window.app
		if (!a) return
		a.agent.describe(() => {
			if (!puzzle) return `Crossword waiting for a theme. Phase: ${phase}.`
			const slotInfo =
				phase === 'awaiting-fill'
					? `Slots to fill:\n${puzzle.slots.map((s) => `  ${s.id} ${s.direction} ${s.pattern}`).join('\n')}`
					: phase === 'playing'
						? `${puzzle.slots.length} slots; user is solving.`
						: phase === 'solved'
							? 'Solved.'
							: ''
			return `Crossword theme "${puzzle.theme}". Phase: ${phase}. ${slotInfo}`
		})

		const unSeeds = a.agent.tools.register({
			name: 'seeds',
			description:
				'Submit themed seed words. Triggers grid generation and returns the slots needing answers.',
			schema: {
				type: 'object',
				properties: { words: { type: 'array', items: { type: 'string' } } },
				required: ['words']
			},
			handler: (input: unknown) => {
				const words = (input as { words?: unknown }).words
				if (!Array.isArray(words) || words.length === 0)
					throw new Error('words must be a non-empty array')
				const seeds = words.map((w) => upper(String(w))).filter((w) => w.length >= 2)
				const built = buildPuzzle(seeds, SIZE)
				if (built.slots.length === 0) throw new Error('no slots produced — try different seeds')
				setPuzzle({ theme, grid: built.grid, slots: built.slots, entries: {} })
				setPhase('awaiting-fill')
				setError(null)
				return {
					placed: seeds.length - built.unplaced.length,
					unplaced: built.unplaced,
					nextStep: fillBriefing(built.slots),
					slots: built.slots.map((s) => ({
						slotId: s.id,
						direction: s.direction,
						pattern: s.pattern,
						length: s.length
					}))
				}
			}
		})

		const unFill = a.agent.tools.register({
			name: 'fill',
			description: 'Provide answer + clue for every slot. Each answer must match its slot pattern.',
			schema: {
				type: 'object',
				properties: {
					entries: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								slotId: { type: 'string' },
								answer: { type: 'string' },
								clue: { type: 'string' }
							},
							required: ['slotId', 'answer', 'clue']
						}
					}
				},
				required: ['entries']
			},
			handler: (input: unknown) => {
				const raw = (input as { entries?: unknown }).entries
				if (!Array.isArray(raw)) throw new Error('entries must be an array')
				setPuzzle((prev) => {
					if (!prev) throw new Error('no puzzle to fill — call seeds first')
					const slotMap = new Map(prev.slots.map((s) => [s.id, s]))
					const entries: Entry[] = raw.map((e) => {
						const o = e as Entry
						const slot = slotMap.get(o.slotId)
						if (!slot) throw new Error(`unknown slot ${o.slotId}`)
						const answer = upper(o.answer)
						if (!patternMatches(answer, slot.pattern))
							throw new Error(`answer ${answer} does not match ${slot.pattern}`)
						if (!o.clue || o.clue.toUpperCase().includes(answer))
							throw new Error(`clue for ${o.slotId} reveals the answer`)
						return { slotId: o.slotId, answer, clue: o.clue }
					})
					const map: Record<string, Entry> = {}
					for (const e of entries) map[e.slotId] = e
					const baked = bakeAnswers(prev.grid, prev.slots, entries)
					return { ...prev, grid: baked, entries: map }
				})
				setUserGrid({})
				setRevealed(new Set())
				setWrong(new Set())
				setPhase('playing')
				setError(null)
				return { ok: true }
			}
		})

		return () => {
			unSeeds()
			unFill()
		}
	}, [puzzle, phase, theme])

	const start = useCallback(() => {
		const t = theme.trim()
		if (!t) return
		setError(null)
		setPuzzle(null)
		setPhase('awaiting-seeds')
		void window.app?.agent
			.send(seedsBriefing(t, 'Once seeds is called I will reply with the slot patterns.'))
			.catch((err: unknown) => {
				setError(err instanceof Error ? err.message : String(err))
				setPhase('idle')
			})
	}, [theme])

	if (!window.app)
		return (
			<main>
				<p className="standby">window.app not injected by host</p>
			</main>
		)

	if (phase === 'idle' || !puzzle)
		return (
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
						onClick={start}
						disabled={phase === 'awaiting-seeds' || !theme.trim()}
					>
						{phase === 'awaiting-seeds' ? 'Generating…' : 'Start'}
					</button>
					{error && <p className="error">{error}</p>}
				</section>
			</main>
		)

	if (phase === 'awaiting-fill')
		return (
			<main>
				<p className="standby">
					Theme "{puzzle.theme}". Waiting for the agent to write clues for {puzzle.slots.length}{' '}
					slot(s)…
				</p>
			</main>
		)

	return (
		<Game
			puzzle={puzzle}
			solved={phase === 'solved'}
			userGrid={userGrid}
			revealed={revealed}
			wrong={wrong}
			onEnter={(r, c, letter) => {
				const k = cellKey(r, c)
				if (revealed.has(k)) return
				setUserGrid((g) => {
					const next = { ...g }
					if (letter) next[k] = letter
					else delete next[k]
					return next
				})
				setWrong((w) => {
					if (!w.has(k)) return w
					const n = new Set(w)
					n.delete(k)
					return n
				})
			}}
			onReveal={(cells) => {
				if (!puzzle.grid) return
				setUserGrid((g) => {
					const next = { ...g }
					for (const k of cells) {
						const [r, c] = parseCell(k)
						const sol = puzzle.grid[r]?.[c]
						if (sol && sol !== '#') next[k] = sol
					}
					return next
				})
				setRevealed((rev) => {
					const n = new Set(rev)
					for (const k of cells) n.add(k)
					return n
				})
				setWrong(new Set())
			}}
			onCheck={(cells) => {
				const next = new Set(wrong)
				for (const k of cells) {
					const [r, c] = parseCell(k)
					const sol = puzzle.grid[r]?.[c]
					if (sol === '#' || sol === undefined) continue
					if (userGrid[k] !== sol) next.add(k)
					else next.delete(k)
				}
				setWrong(next)
			}}
		/>
	)
}

type GameProps = {
	puzzle: Puzzle
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
				;(s.direction === 'across' ? a : d).set(cellKey(r, c), s.id)
			}
		}
		return { across: a, down: d }
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

const root = document.getElementById('root')
if (root)
	createRoot(root).render(
		<StrictMode>
			<App />
		</StrictMode>
	)
