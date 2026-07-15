import agentAvatarUrl from '../agent/agent-avatar.png'

// Decorative summoning overlay: rotating rune ring + the pixel spirit, drawn in
// currentColor so it inherits whatever theme the sheet is wearing.
export function RitualCircle({ fast = false }: { fast?: boolean }) {
	return (
		<div className="frn-ritual-circle" data-fast={fast} aria-hidden="true">
			<div className="frn-ritual-circle-ring" />
			<svg viewBox="0 0 200 200">
				<title>Summoning circle</title>
				<defs>
					<path id="frn-rune-path" d="M 30,100 a 70,70 0 1,1 140,0 a 70,70 0 1,1 -140,0" />
				</defs>
				<text>
					<textPath href="#frn-rune-path" startOffset="2%">
						ᚠ · ᚱ · ᛁ · ᛖ · ᚱ · ᛖ · ᚾ · ᚨ · ᛋ · ᛟ · ᚢ · ᛚ · ᚹ · ᚨ · ᛁ · ᛏ · ᛋ ·
					</textPath>
				</text>
			</svg>
			<img src={agentAvatarUrl} alt="" />
		</div>
	)
}
