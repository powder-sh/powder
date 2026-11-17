import { cn } from '@/lib/cn'

// The one status vocabulary. Every dot, pill and label maps onto these tones.
export type StatusTone = 'success' | 'warning' | 'destructive' | 'info' | 'neutral'

const dotTone: Record<StatusTone, string> = {
	success: 'bg-success',
	warning: 'bg-warning',
	destructive: 'bg-destructive',
	info: 'bg-info',
	neutral: 'bg-muted-foreground/50',
}

const textTone: Record<StatusTone, string> = {
	success: 'text-success',
	warning: 'text-warning',
	destructive: 'text-destructive',
	info: 'text-info',
	neutral: 'text-muted-foreground',
}

export function StatusDot({
	tone,
	pulse = false,
	className,
}: {
	tone: StatusTone
	pulse?: boolean
	className?: string
}) {
	return (
		<span aria-hidden className={cn('relative inline-flex h-2 w-2 shrink-0', className)}>
			{pulse && (
				<span
					className={cn('absolute inset-0 animate-ping rounded-full opacity-60', dotTone[tone])}
				/>
			)}
			<span className={cn('relative inline-block h-2 w-2 rounded-full', dotTone[tone])} />
		</span>
	)
}

// Dot + label, text colored by tone. Use in tables and headers.
export function StatusLabel({
	tone,
	pulse,
	children,
	className,
}: {
	tone: StatusTone
	pulse?: boolean
	children: React.ReactNode
	className?: string
}) {
	return (
		<span
			className={cn(
				'inline-flex items-center gap-1.5 whitespace-nowrap text-sm',
				textTone[tone],
				tone === 'success' && 'text-foreground',
				className,
			)}
		>
			<StatusDot tone={tone} pulse={pulse} />
			{children}
		</span>
	)
}
