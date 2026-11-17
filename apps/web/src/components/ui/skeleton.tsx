import { cn } from '@/lib/cn'

export function Skeleton({ className }: { className?: string }) {
	return <div aria-hidden className={cn('animate-shimmer rounded-md bg-muted', className)} />
}

const ROW_KEYS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']

// Placeholder for a list or table while it loads. Announces itself once.
export function SkeletonList({
	rows = 4,
	className,
	label = 'loading',
	bare = false,
}: {
	rows?: number
	className?: string
	label?: string
	// No frame: for use inside a card that already has one.
	bare?: boolean
}) {
	return (
		<div
			aria-busy="true"
			className={cn(
				'overflow-hidden',
				!bare && 'rounded-lg border border-border bg-card',
				className,
			)}
		>
			{ROW_KEYS.slice(0, rows).map((k, i) => (
				<div
					key={k}
					className={cn(
						'flex items-center gap-4 border-b border-border py-3.5 last:border-0',
						bare ? 'px-0' : 'px-4',
					)}
				>
					<Skeleton className="h-2 w-2 rounded-full" />
					<div className="flex-1 space-y-2">
						<Skeleton className={cn('h-3', i % 2 ? 'w-1/3' : 'w-1/2')} />
						<Skeleton className="h-2.5 w-1/4" />
					</div>
					<Skeleton className="hidden h-7 w-20 sm:block" />
				</div>
			))}
			<span className="sr-only">{label}</span>
		</div>
	)
}
