import type { Destination } from './settings'

type Props = {
	destinations: Destination[]
	active: Destination
	onSelect: (dest: Destination) => void
}

export function ModeSelector({ destinations, active, onSelect }: Props) {
	return (
		<select
			value={active.id}
			onChange={(e) => {
				const dest = destinations.find((d) => d.id === e.target.value)
				if (dest) onSelect(dest)
			}}
			className="text-xs font-mono bg-transparent cursor-pointer outline-none text-base-content/60 hover:text-base-content transition-colors"
		>
			{destinations.map((dest) => (
				<option key={dest.id} value={dest.id}>{dest.name.toLowerCase()}</option>
			))}
		</select>
	)
}
