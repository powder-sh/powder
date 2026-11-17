'use client'

// Dashboard error boundary. Shows what to do next, never the error text or
// stack (they can carry hostnames, paths or secrets); the digest lets the
// operator find the full error in the server log.

import { RotateCcw } from 'lucide-react'
import Link from 'next/link'
import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { buttonVariants } from '@/components/ui/button-variants'
import { EmptyState } from '@/components/ui/empty-state'

export default function DashboardError({
	error,
	reset,
}: {
	error: Error & { digest?: string }
	reset: () => void
}) {
	useEffect(() => {
		// The browser console only; nothing is rendered from it.
		console.error(error)
	}, [error])

	return (
		<div className="py-10">
			<EmptyState
				title="this page hit an error"
				action={
					<>
						<Button size="sm" onClick={() => reset()}>
							<RotateCcw className="h-3 w-3" />
							try again
						</Button>
						<Link href="/projects" className={buttonVariants({ size: 'sm', variant: 'outline' })}>
							back to apps
						</Link>
					</>
				}
			>
				{error.digest ? (
					<>
						the server log of powder has the details under{' '}
						<code className="font-mono text-foreground">{error.digest}</code>.
					</>
				) : (
					'the browser console has the details.'
				)}
			</EmptyState>
		</div>
	)
}
