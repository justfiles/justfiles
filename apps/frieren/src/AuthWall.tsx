import { SignInButton, SignUpButton } from '@clerk/clerk-react'
import { Badge } from './components/ui/badge'
import { Button } from './components/ui/button'
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from './components/ui/card'

export function AuthWall() {
	return (
		<div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-background px-6 py-10">
			<div className="absolute inset-0 bg-[radial-gradient(circle_at_top,rgba(0,0,0,0.05),transparent_55%)] dark:bg-[radial-gradient(circle_at_top,rgba(255,255,255,0.08),transparent_55%)]" />
			<Card className="relative w-full max-w-xl border border-border/60 bg-background/95 backdrop-blur">
				<CardHeader className="gap-3">
					<Badge variant="outline" className="w-fit tracking-[0.24em] uppercase">
						Frieren
					</Badge>
					<CardTitle className="max-w-lg text-3xl leading-tight sm:text-4xl">
						Your personal agent, behind a sign-in.
					</CardTitle>
					<CardDescription className="max-w-lg text-sm/6 sm:text-base/7">
						Sign in to chat with Frieren. Your conversations, onboarding, and files
						are scoped to your account.
					</CardDescription>
				</CardHeader>
				<CardContent className="grid gap-3 sm:grid-cols-2">
					<div className="border border-border bg-muted/30 p-3">
						<p className="font-medium text-foreground">Scoped memory</p>
						<p className="mt-1 text-muted-foreground">
							Your workspace stays attached to you, not the browser tab.
						</p>
					</div>
					<div className="border border-border bg-muted/30 p-3">
						<p className="font-medium text-foreground">Persistent files</p>
						<p className="mt-1 text-muted-foreground">
							Notes, profiles, and generated artifacts stay available after you come
							back.
						</p>
					</div>
				</CardContent>
				<CardFooter className="flex-col gap-2 border-t-0 pt-0 sm:flex-row">
					<SignInButton>
						<Button type="button" size="lg" className="w-full flex-1">
							Sign in
						</Button>
					</SignInButton>
					<SignUpButton>
						<Button type="button" variant="outline" size="lg" className="w-full flex-1">
							Get started
						</Button>
					</SignUpButton>
				</CardFooter>
			</Card>
		</div>
	)
}
