import { buttonVariants } from '@/components/ui/button-variants'
import { EmptyState } from '@/components/ui/empty-state'
import { SearchX } from 'lucide-react'
import Link from 'next/link'

// notFound() inside the dashboard: keep the sidebar and say where to go.
export default function DashboardNotFound() {
	return (
		<EmptyState
			icon={SearchX}
			title="not found"
			action={
				<Link href="/projects" className={buttonVariants({ size: 'sm', variant: 'outline' })}>
					back to apps
				</Link>
			}
		>
			it may have been removed, or the link is wrong.
		</EmptyState>
	)
}
