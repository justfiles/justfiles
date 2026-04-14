import { SignInButton, SignUpButton } from '@clerk/clerk-react'

export function AuthWall() {
	return (
		<div className="min-h-dvh bg-base-100 flex flex-col items-center justify-center gap-8 px-6 text-center">
			<div className="badge badge-outline badge-sm tracking-widest uppercase opacity-60">
				Frieren
			</div>
			<h1 className="text-4xl sm:text-5xl font-bold leading-tight max-w-xl">
				Your personal agent, <span className="text-primary">behind a sign-in</span>
			</h1>
			<p className="text-base-content/60 text-lg max-w-md leading-relaxed">
				Sign in to chat with Frieren. Your conversations and files are scoped to
				your account.
			</p>
			<div className="flex flex-wrap gap-3 justify-center">
				<SignInButton>
					<button type="button" className="btn btn-primary btn-lg px-8">
						Sign in
					</button>
				</SignInButton>
				<SignUpButton>
					<button type="button" className="btn btn-outline btn-lg px-8">
						Get started
					</button>
				</SignUpButton>
			</div>
		</div>
	)
}
