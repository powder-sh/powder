import { cn } from '@/lib/cn'

// Shared by <Button> and by links that look like buttons (Next <Link>, <a>),
// so both render identically. Plain function: safe in server components.
const buttonVariantClasses = {
	// Solid, high-emphasis. One per view.
	default: 'bg-primary text-primary-foreground hover:bg-primary/85 shadow-card',
	// Bordered, the workhorse for secondary actions.
	outline:
		'border border-border-strong bg-card text-foreground hover:bg-accent hover:border-border-strong',
	// Quiet, for toolbars and dense rows.
	ghost: 'text-muted-foreground hover:bg-accent hover:text-foreground',
	destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
	// Bordered but red, for destructive actions that are not the primary one.
	'destructive-outline':
		'border border-destructive/40 bg-transparent text-destructive hover:bg-destructive/10',
	link: 'text-foreground underline underline-offset-4 decoration-border-strong hover:decoration-foreground h-auto sm:h-auto px-0',
} as const

// Below the sm breakpoint every size is at least 40px tall: a thumb, not a cursor.
const buttonSizeClasses = {
	default: 'h-10 gap-2 px-3.5 text-sm sm:h-9',
	sm: 'h-10 gap-1.5 px-3 text-xs sm:h-8',
	xs: 'h-10 gap-1 px-2.5 text-xs sm:h-7 sm:px-2',
	lg: 'h-11 gap-2 px-5 text-sm',
	icon: 'h-10 w-10 sm:h-9 sm:w-9',
	'icon-sm': 'h-10 w-10 sm:h-8 sm:w-8',
} as const

export type ButtonVariant = keyof typeof buttonVariantClasses
export type ButtonSize = keyof typeof buttonSizeClasses

export function buttonVariants(
	opts: { variant?: ButtonVariant; size?: ButtonSize; className?: string } = {},
): string {
	const { variant = 'default', size = 'default', className } = opts
	return cn(
		'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap rounded-md font-medium transition-colors',
		'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
		'disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50',
		'[&_svg]:shrink-0',
		buttonSizeClasses[size],
		buttonVariantClasses[variant],
		className,
	)
}
