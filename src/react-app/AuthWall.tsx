import { SignInButton, SignUpButton } from '@clerk/clerk-react'

export function AuthWall() {
	return (
		<div className="h-screen grid place-items-center bg-slate-50 p-4">
			<div className="w-[min(560px,100%)] p-6 text-center border border-slate-200 rounded-xl bg-white">
				<h1 className="m-0">Ghostore</h1>
				<p className="mb-4">Sign in or create an account to access your memories.</p>
				<div className="flex justify-center gap-3">
					<SignInButton />
					<SignUpButton />
				</div>
			</div>
		</div>
	)
}
