const PALETTE = [
	'#000000',
	'#ffffff',
	'#e64545',
	'#f5b400',
	'#3aa84a',
	'#3b78e6',
	'#7e3bd4',
	'#8c5a2c'
]

export function ColorStrip(props: { color: string; onColor: (c: string) => void }) {
	return (
		<footer
			className="flex flex-none items-center gap-2 px-3 py-2"
			style={{
				background: 'var(--surface)',
				borderTop: '1px solid var(--rule)'
			}}
		>
			<div
				title={`Current color ${props.color}`}
				style={{
					width: 28,
					height: 28,
					background: props.color,
					border: '1px solid var(--rule)',
					borderRadius: 3
				}}
			/>
			<div className="flex gap-1">
				{PALETTE.map((c) => {
					const active = props.color.toLowerCase() === c
					return (
						<button
							key={c}
							type="button"
							title={c}
							aria-label={c}
							aria-pressed={active}
							onClick={() => props.onColor(c)}
							style={{
								width: 18,
								height: 18,
								background: c,
								border: active ? '2px solid var(--focus)' : '1px solid var(--rule)',
								borderRadius: 2,
								cursor: 'default'
							}}
						/>
					)
				})}
			</div>
			<label className="ml-2 flex items-center gap-1 text-[11px]" style={{ color: 'var(--text)' }}>
				<span className="opacity-60">Custom</span>
				<input
					type="color"
					value={props.color}
					onChange={(e) => props.onColor(e.target.value)}
					style={{ width: 22, height: 22, padding: 0, border: 'none', background: 'transparent' }}
				/>
			</label>
		</footer>
	)
}
