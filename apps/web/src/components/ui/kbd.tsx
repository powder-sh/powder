import { cn } from '@/lib/cn'

export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
	return (
		<kbd
			className={cn(
				'inline-flex h-5 min-w-5 items-center justify-center rounded border border-border-strong bg-muted px-1 font-mono text-2xs font-medium text-muted-foreground',
				className,
			)}
		>
			{children}
		</kbd>
	)
}
