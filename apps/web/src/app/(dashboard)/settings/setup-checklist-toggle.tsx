'use client'

// Brings the setup checklist back to the apps page after it was hidden there.

import { readChecklistHidden, setChecklistHidden } from '@/components/setup-checklist-card'
import { buttonVariants } from '@/components/ui/button-variants'
import { ListChecks } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

export function SetupChecklistToggle() {
	const router = useRouter()
	const [hidden, setHidden] = useState(false)
	useEffect(() => setHidden(readChecklistHidden()), [])
	if (!hidden) return null
	return (
		<div className="flex items-center gap-4 rounded-lg border border-border bg-card px-4 py-3 shadow-card">
			<span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
				<ListChecks className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
			</span>
			<div className="min-w-0 flex-1">
				<div className="text-sm font-medium">setup checklist</div>
				<div className="text-xs text-muted-foreground">hidden on the apps page</div>
			</div>
			<button
				type="button"
				onClick={() => {
					setChecklistHidden(false)
					router.push('/projects')
				}}
				className={buttonVariants({ variant: 'outline', size: 'sm' })}
			>
				show it again
			</button>
		</div>
	)
}
