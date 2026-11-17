'use client'

import { RECREATE_COMMAND } from '@/lib/recreate-hint'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { signIn } from '@/lib/auth-client'

function GithubIcon() {
	return (
		<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
			<path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
		</svg>
	)
}

/** `github`: GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are set (read per request by page.tsx). */
export function LoginForm({ github }: { github: boolean }) {
	const router = useRouter()
	const [email, setEmail] = useState('')
	const [password, setPassword] = useState('')
	const [error, setError] = useState<string | null>(null)
	const [loading, setLoading] = useState(false)
	const [ghLoading, setGhLoading] = useState(false)

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault()
		setError(null)
		setLoading(true)
		try {
			const { error: err } = await signIn.email({ email, password })
			if (err) {
				setError(err.message ?? 'sign-in failed')
				return
			}
			router.replace('/projects')
			router.refresh()
		} catch {
			setError('sign-in failed: network error')
		} finally {
			setLoading(false)
		}
	}

	async function continueWithGithub() {
		setError(null)
		setGhLoading(true)
		try {
			await signIn.social({ provider: 'github', callbackURL: '/projects' })
			// the call above redirects; this only runs if user lands back here
		} catch {
			setError('sign-in failed: network error')
		} finally {
			setGhLoading(false)
		}
	}

	return (
		<div className="space-y-6">
			<div className="space-y-1.5 text-center">
				<h1 className="font-display text-3xl font-bold">Sign in to powder</h1>
				<p className="text-sm text-muted-foreground">The control plane for your servers.</p>
			</div>
			<div className="space-y-5 rounded-xl border border-border bg-card p-5 shadow-card sm:p-6">
				{github ? (
					<Button
						type="button"
						size="lg"
						onClick={continueWithGithub}
						disabled={loading}
						loading={ghLoading}
						className="w-full"
					>
						{!ghLoading && <GithubIcon />}
						{ghLoading ? 'Redirecting to GitHub…' : 'Continue with GitHub'}
					</Button>
				) : (
					<Alert tone="info" title="GitHub sign-in is not set up">
						Set <code className="font-mono">GITHUB_CLIENT_ID</code> and{' '}
						<code className="font-mono">GITHUB_CLIENT_SECRET</code> in powder.env, then recreate the containers (a restart does not re-read the file): in the powder source dir run{' '}
						<code className="font-mono break-all">{RECREATE_COMMAND}</code>. See the{' '}
						<a href="/docs/quickstart" className="underline">
							quickstart
						</a>
						.
					</Alert>
				)}
				{github && (
					<div className="flex items-center gap-3 text-xs text-muted-foreground">
						<div className="h-px flex-1 bg-border" />
						or with email
						<div className="h-px flex-1 bg-border" />
					</div>
				)}
				<form onSubmit={handleSubmit} className="space-y-4">
					<Input
						id="login-email"
						label="Email"
						type="email"
						autoComplete="email"
						inputMode="email"
						value={email}
						onChange={(e) => setEmail(e.target.value)}
						required
					/>
					<Input
						id="login-password"
						label="Password"
						type="password"
						autoComplete="current-password"
						value={password}
						onChange={(e) => setPassword(e.target.value)}
						required
					/>
					{error && (
						<Alert tone="destructive" title="Could not sign in">
							{error}
						</Alert>
					)}
					<Button
						type="submit"
						variant={github ? 'outline' : 'default'}
						size="lg"
						disabled={ghLoading}
						loading={loading}
						className="w-full"
					>
						{loading ? 'Signing in…' : 'Sign in with email'}
					</Button>
				</form>
			</div>
			<p className="text-center text-xs text-muted-foreground">
				No signup. Fresh install: enter the setup token from the server log at{' '}
				<a href="/setup" className="underline">
					/setup
				</a>
				, then the first GitHub login becomes the admin. Email accounts are created by the admin.
			</p>
		</div>
	)
}
