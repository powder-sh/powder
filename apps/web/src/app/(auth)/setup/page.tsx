import { Alert } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { buttonVariants } from '@/components/ui/button-variants'
import { Input } from '@/components/ui/input'
import { firstRunOpen } from '@/lib/first-run'
import Link from 'next/link'

// First-run gate (lib/first-run.ts). On a fresh install the server log prints
// "[first-run] setup token: ...". Entering it here sets a short-lived cookie;
// only a GitHub login carrying that cookie can become the first admin.
export default async function SetupPage({
	searchParams,
}: {
	searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
	const { state } = await searchParams
	// Closed (an admin exists): only the notice and the way to sign in.
	if (state === 'done' || !(await firstRunOpen().catch(() => true))) {
		return (
			<div className="space-y-6 text-center">
				<div className="space-y-1.5">
					<h1 className="font-display text-3xl font-bold">Setup is done</h1>
					<p className="text-sm text-muted-foreground">This powder already has an admin.</p>
				</div>
				<Link href="/login" className={buttonVariants({ size: 'lg', className: 'w-full' })}>
					Sign in
				</Link>
			</div>
		)
	}
	return (
		<div className="space-y-6">
			<div className="space-y-1.5 text-center">
				<h1 className="font-display text-3xl font-bold">Set up powder</h1>
				<p className="text-sm text-muted-foreground">
					Enter the setup token from the server log, then continue with GitHub. That login becomes
					the admin.
				</p>
			</div>
			<div className="space-y-5 rounded-xl border border-border bg-card p-5 shadow-card sm:p-6">
				{state === 'bad' && (
					<Alert tone="destructive" title="Wrong setup token">
						Copy it again from the line starting with [first-run] setup token in the powder log
						(<code className="font-mono">docker logs powder 2&gt;&amp;1 | grep &apos;setup token&apos;</code>).
						A restart makes a new token.
					</Alert>
				)}
				<form method="post" action="/api/setup/token" className="space-y-4">
					<Input
						id="setup-token"
						name="token"
						label="Setup token"
						autoComplete="off"
						spellCheck={false}
						required
					/>
					<Button type="submit" size="lg" className="w-full">
						Continue
					</Button>
				</form>
			</div>
		</div>
	)
}
