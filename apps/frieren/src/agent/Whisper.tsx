export function Whisper({ onPersonalize }: { onPersonalize: () => void }) {
	return (
		<div className="frn-agent-whisper">
			<em>A nameless spirit answers you.</em>
			<button type="button" onClick={onPersonalize}>
				Give it a soul →
			</button>
		</div>
	)
}
