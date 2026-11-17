import { cn } from '@/lib/cn'

// Tones are shared with <StatusDot>: one meaning per color across the app.
// success = live/healthy, warning = in progress or needs a look,
// destructive = failed/down, info = neutral notice, outline = metadata.
const variants = {
	default: 'border-transparent bg-primary text-primary-foreground',
	outline: 'border-border bg-transparent text-muted-foreground',
	secondary: 'border-transparent bg-muted text-muted-foreground',
	success: 'border-success/25 bg-success/10 text-success',
	warning: 'border-warning/25 bg-warning/10 text-warning',
	destructive: 'border-destructive/25 bg-destructive/10 text-destructive',
	info: 'border-info/25 bg-info/10 text-info',
	powder: 'border-powder/30 bg-powder/10 text-foreground',
} as const

export type BadgeVariant = keyof typeof variants

interface BadgeProps {
	variant?: BadgeVariant
	children: React.ReactNode
	className?: string
	title?: string
}

export function Badge({ variant = 'default', className, children, title }: BadgeProps) {
	return (
		<span
			title={title}
			className={cn(
				'inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 text-2xs font-medium [&_svg]:h-3 [&_svg]:w-3',
				variants[variant],
				className,
			)}
		>
			{children}
		</span>
	)
}
