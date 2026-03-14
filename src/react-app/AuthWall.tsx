import { SignInButton, SignUpButton } from '@clerk/clerk-react'

export function AuthWall() {
	return (
		<div className="h-screen grid place-items-center bg-base-200 p-4">
			<div className="card bg-base-100 border border-base-200 shadow-md w-[min(560px,100%)]">
				<div className="card-body text-center">
					<h1 className="card-title justify-center text-2xl">Ghostore</h1>
					<p className="text-base-content/70">Sign in or create an account to access your memories.</p>
					<div className="card-actions justify-center mt-2 gap-3">
						<SignInButton>
							<button type="button" className="btn btn-primary">Sign in</button>
						</SignInButton>
						<SignUpButton>
							<button type="button" className="btn btn-outline">Sign up</button>
						</SignUpButton>
					</div>
				</div>
			</div>
		</div>
	)
}
