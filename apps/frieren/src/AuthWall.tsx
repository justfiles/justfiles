import { SignInButton, SignUpButton } from '@clerk/clerk-react'
import frierenAvatar from './assets/frieren.avif'
import { Button } from './components/ui/button'

export function AuthWall() {
	return (
		<div
			className="flex min-h-dvh flex-col items-center justify-center px-6 text-white"
			style={{
				background:
					'radial-gradient(ellipse at 50% 30%, rgba(255,255,255,0.12), transparent 60%), var(--desktop-bg)'
			}}
		>
			<img
				src={frierenAvatar}
				alt=""
				aria-hidden="true"
				className="size-24 rounded-full border-2 border-white/80 object-cover shadow-[0_6px_24px_rgba(0,0,0,0.35)]"
			/>
			<p className="mt-4 text-base font-medium tracking-wide">Frieren</p>
			<p className="mt-1 text-xs text-white/65">your personal agent</p>

			<div className="mt-6 flex items-center gap-2">
				<SignInButton>
					<Button type="button" className="min-w-28">
						Sign in
					</Button>
				</SignInButton>
				<SignUpButton>
					<Button type="button" variant="outline" className="min-w-28">
						Create account
					</Button>
				</SignUpButton>
			</div>
		</div>
	)
}
