import { cn } from '@/lib/cn'
import type { LucideIcon } from 'lucide-react'

// Empty and dead-end states: say what happened and what to do next.
export function EmptyState({
	icon: Icon,
	title,
	children,
	action,
	className,
	compact = false,
}: {
	icon?: LucideIcon
	title: React.ReactNode
	children?: React.ReactNode
	action?: React.ReactNode
	className?: string
	compact?: boolean
}) {
	return (
		<div
			className={cn(
				'flex flex-col items-center rounded-lg border border-dashed border-border-strong bg-card/50 text-center',
				compact ? 'px-4 py-6' : 'px-6 py-12',
				className,
			)}
		>
			{Icon && (
				<div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full border border-border bg-muted">
					<Icon className="h-4.5 w-4.5 text-muted-foreground" aria-hidden />
				</div>
			)}
			<p className="text-sm font-semibold">{title}</p>
			{children && (
				<div className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">{children}</div>
			)}
			{action && <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div>}
		</div>
	)
}
