import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { AppFrame } from '../AppFrame'
import { BuiltinHost } from '../BuiltinHost'
import { builtinLauncherEntries } from '../builtin'
import { EsmAppFrame } from '../EsmAppFrame'
import { KernelAppFrame } from '../KernelAppFrame'
import { LauncherView } from '../LauncherView'
import { AppPromptBlock } from './AppPromptBlock'
import { AssistantAvatar, useAdventureViewState } from './adventureShared'
import { ToolCallBlock } from './ToolCallBlock'
import type { ChatViewProps } from './types'

export function ShadcnView(props: ChatViewProps) {
	const { session, connection, apps } = props
	const { messages, input, setInput, userName, agentName, isStreaming, sendMessage, abort } =
		session
	const connectionState = connection.state
	const { dismissPanel, history, historyRef, inputRef, pinned, setFocused, showPanel, submit } =
		useAdventureViewState({ messages, input, sendMessage })

	return (
		<div className="relative flex w-full flex-1 overflow-hidden bg-gradient-to-b from-background via-slate-950 to-slate-950 font-mono text-foreground">
			<div
				ref={historyRef}
				className="flex min-w-0 flex-[1] flex-col gap-3 overflow-y-auto border-r-4 border-double border-sky-300/40 px-6 py-4"
			>
				{history.length === 0 ? (
					<div className="flex flex-1 items-center justify-center text-muted-foreground">
						<p>* A mysterious silence fills the air... *</p>
					</div>
				) : null}
				{history.map((message) => {
					if (message.source === 'app') {
						return <AppPromptBlock key={message.id} content={message.content} />
					}

					const isUser = message.role === 'user'
					const toolOnly =
						!isUser && !message.content && !message.thinking && !!message.toolCalls?.length

					if (toolOnly) {
						return (
							<div key={message.id} className="flex flex-col gap-1">
								<Badge
									variant="outline"
									className="w-fit rounded-none border-sky-300 bg-transparent px-1.5 py-0 font-mono text-[10px] uppercase tracking-[0.24em] text-sky-200"
								>
									{agentName}
								</Badge>
								<div className="flex max-w-[75%] flex-col gap-1">
									{message.toolCalls?.map((toolCall) => (
										<ToolCallBlock key={toolCall.id} toolCall={toolCall} />
									))}
								</div>
							</div>
						)
					}

					return (
						<div key={message.id} className="flex flex-col gap-1">
							<div className={cn('flex items-start gap-3', !isUser && 'flex-row-reverse')}>
								<div
									className={cn(
										'flex h-10 w-10 shrink-0 items-center justify-center border-2 border-double text-xl shadow-[3px_3px_0_rgba(0,0,0,0.45)]',
										isUser
											? 'border-amber-300 bg-amber-950 text-amber-100'
											: 'overflow-hidden border-sky-300 bg-slate-950'
									)}
								>
									{isUser ? (
										'🗡️'
									) : (
										<AssistantAvatar
											size={40}
											className="h-full w-full object-cover object-center"
										/>
									)}
								</div>
								<Card
									size="sm"
									className={cn(
										'max-w-[75%] gap-2 rounded-none border-2 border-double px-3 py-2 shadow-[4px_4px_0_rgba(0,0,0,0.45)]',
										isUser
											? 'border-amber-300 bg-slate-900/90 text-amber-50'
											: 'border-sky-300 bg-slate-900/90 text-sky-50'
									)}
								>
									<Badge
										variant="outline"
										className={cn(
											'w-fit rounded-none border-current bg-transparent px-1.5 py-0 font-mono text-[10px] uppercase tracking-[0.24em]',
											isUser ? 'text-amber-200' : 'text-sky-200'
										)}
									>
										{isUser ? userName : agentName}
									</Badge>
									<div className="whitespace-pre-wrap break-words text-sm leading-relaxed">
										{message.content}
										{!message.content && isStreaming && !isUser ? (
											<span className="ml-px inline-block h-[1em] w-0.5 animate-pulse bg-current align-text-bottom" />
										) : null}
									</div>
								</Card>
							</div>
							{message.toolCalls && message.toolCalls.length > 0 ? (
								<div className="ml-14 flex flex-col gap-1">
									{message.toolCalls.map((toolCall) => (
										<ToolCallBlock key={toolCall.id} toolCall={toolCall} />
									))}
								</div>
							) : null}
						</div>
					)
				})}
			</div>

			<div className="flex min-w-0 flex-[1.618] flex-col bg-slate-950/60">
				<div className="flex min-h-0 flex-[1.618] flex-col border-b-4 border-double border-sky-300/60 p-4">
					<div className="relative flex flex-1 items-center justify-center overflow-hidden border-4 border-double border-sky-300 bg-gradient-to-b from-indigo-950 via-slate-900 to-slate-950 shadow-[6px_6px_0_rgba(0,0,0,0.45)]">
						{apps && apps.launcher.activeApp?.kind === 'sandbox' ? (
							<AppFrame
								id={apps.launcher.activeApp.id}
								ui={apps.launcher.activeApp.ui}
								relay={apps.relay}
								onHome={apps.launcher.close}
							/>
						) : apps && apps.launcher.activeApp?.kind === 'esm' ? (
							<EsmAppFrame
								id={apps.launcher.activeApp.id}
								manifestUrl={apps.launcher.activeApp.manifestUrl}
								baseUrl={apps.launcher.activeApp.baseUrl}
								onHome={apps.launcher.close}
							/>
						) : apps && apps.launcher.activeApp?.kind === 'builtin' ? (
							<BuiltinHost id={apps.launcher.activeApp.id} onHome={apps.launcher.close} />
						) : apps && apps.launcher.activeApp?.kind === 'kernel' ? (
							<KernelAppFrame id={apps.launcher.activeApp.id} onHome={apps.launcher.close} />
						) : apps ? (
							<LauncherView
								apps={[...apps.launcher.installedApps, ...builtinLauncherEntries()]}
								onLaunch={apps.launcher.launch}
								onInstallKernelApp={
									apps.launcher.installKernelApp
										? () => void apps.launcher.installKernelApp?.()
										: undefined
								}
							/>
						) : null}
						{apps?.launcher.activeApp ? (
							<Badge
								variant="outline"
								className="absolute bottom-2 left-2 rounded-none border-sky-300 bg-slate-950/90 px-1.5 py-0 font-mono text-[10px] uppercase tracking-[0.24em] text-sky-200"
							>
								{agentName}
							</Badge>
						) : null}
						{isStreaming ? (
							<Badge
								variant="outline"
								className="absolute bottom-2 right-2 rounded-none border-amber-300 bg-slate-950/90 px-1.5 py-0 font-mono text-[10px] uppercase tracking-[0.24em] text-amber-200"
							>
								▸ Speaking...
							</Badge>
						) : null}
					</div>
				</div>

				<div className="flex min-h-0 flex-[1] flex-col p-4">
					<Card
						size="sm"
						className={cn(
							'flex min-h-0 flex-1 flex-col gap-2 rounded-none border-4 border-double border-sky-300 bg-slate-950/90 px-4 py-3 shadow-[6px_6px_0_rgba(0,0,0,0.45)]',
							showPanel && !isStreaming && 'cursor-pointer hover:border-amber-300'
						)}
						onClick={showPanel && !isStreaming ? dismissPanel : undefined}
					>
						{showPanel && pinned ? (
							<>
								<div className="flex items-center justify-between gap-3">
									<Badge
										variant="outline"
										className="rounded-none border-sky-300 bg-transparent px-1.5 py-0 font-mono text-[10px] uppercase tracking-[0.24em] text-sky-200"
									>
										{agentName}
									</Badge>
									{isStreaming ? (
										<Button
											type="button"
											variant="destructive"
											size="xs"
											onClick={(event) => {
												event.stopPropagation()
												abort()
											}}
										>
											Stop
										</Button>
									) : (
										<span className="text-[10px] uppercase tracking-[0.24em] text-amber-300/80">
											▸ Click to reply
										</span>
									)}
								</div>
								<div className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words text-sm leading-relaxed text-sky-50">
									{pinned.content ||
										(!pinned.toolCalls?.length ? <span className="opacity-60">...</span> : null)}
									{isStreaming ? (
										<span className="ml-px inline-block h-[1em] w-1 animate-pulse bg-sky-200 align-text-bottom" />
									) : null}
								</div>
								{pinned.toolCalls && pinned.toolCalls.length > 0 ? (
									<div className="flex flex-col gap-1">
										{pinned.toolCalls.map((toolCall) => (
											<ToolCallBlock key={toolCall.id} toolCall={toolCall} />
										))}
									</div>
								) : null}
							</>
						) : (
							<form
								className="flex min-h-0 flex-1 flex-col"
								onSubmit={(event) => {
									event.preventDefault()
									submit()
								}}
							>
								<div className="mb-2 flex items-center justify-between gap-3">
									<Badge
										variant="outline"
										className="rounded-none border-amber-300 bg-transparent px-1.5 py-0 font-mono text-[10px] uppercase tracking-[0.24em] text-amber-200"
									>
										{userName}
									</Badge>
									{connectionState !== 'ready' ? (
										<span className="text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
											{connectionState}
										</span>
									) : null}
								</div>
								<Textarea
									ref={inputRef}
									className="min-h-0 flex-1 resize-none border-0 bg-transparent px-0 py-0 text-sm leading-relaxed text-amber-50 shadow-none placeholder:text-muted-foreground focus-visible:border-0 focus-visible:ring-0 disabled:bg-transparent dark:bg-transparent dark:disabled:bg-transparent"
									value={input}
									onChange={(event) => setInput(event.target.value)}
									onFocus={() => setFocused(true)}
									onBlur={() => setFocused(false)}
									onKeyDown={(event) => {
										if (event.key === 'Enter' && !event.shiftKey) {
											event.preventDefault()
											submit()
										}
									}}
									placeholder={connectionState === 'ready' ? 'What will you say?' : 'Connecting...'}
									disabled={connectionState !== 'ready'}
								/>
								<div className="mt-2 flex justify-end text-[10px] uppercase tracking-[0.24em] text-muted-foreground">
									▼ Enter to speak
								</div>
							</form>
						)}
					</Card>
				</div>
			</div>
		</div>
	)
}
