import { useState } from 'react'
import { Badge } from '@/components/ui/badge'

export function AppPromptBlock({ content }: { content: string }) {
	const [expanded, setExpanded] = useState(false)

	return (
		<details
			className="group rounded border border-border/70 bg-muted/50 text-xs text-muted-foreground"
			open={expanded}
			onToggle={(event) => setExpanded(event.currentTarget.open)}
		>
			<summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 marker:hidden [&::-webkit-details-marker]:hidden">
				<Badge variant="outline" className="h-5 px-1.5 uppercase text-muted-foreground">
					App
				</Badge>
				<span className="min-w-0 flex-1 truncate">Prompt sent to agent</span>
				<span className="transition group-open:rotate-90">&gt;</span>
			</summary>
			<pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words border-t border-border/70 px-3 py-2 font-mono text-[11px] leading-relaxed text-foreground">
				{content}
			</pre>
		</details>
	)
}
