import { cn } from '@/lib/cn'

// Data table chrome. Wrap in <TableFrame> for the border and horizontal scroll.
export function TableFrame({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
	return (
		<div
			className={cn(
				'overflow-x-auto rounded-lg border border-border bg-card shadow-card',
				className,
			)}
			{...props}
		/>
	)
}

export function Table({ className, ...props }: React.TableHTMLAttributes<HTMLTableElement>) {
	return <table className={cn('w-full text-left text-sm', className)} {...props} />
}

export function THead({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
	return (
		<thead
			className={cn('border-b border-border bg-muted/40 text-xs text-muted-foreground', className)}
			{...props}
		/>
	)
}

export function TBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
	return <tbody className={cn('divide-y divide-border', className)} {...props} />
}

export function Th({ className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
	return (
		<th
			scope="col"
			className={cn('whitespace-nowrap px-4 py-2.5 font-medium', className)}
			{...props}
		/>
	)
}

export function Td({ className, ...props }: React.TdHTMLAttributes<HTMLTableCellElement>) {
	return <td className={cn('px-4 py-3', className)} {...props} />
}

export function Tr({ className, ...props }: React.HTMLAttributes<HTMLTableRowElement>) {
	return <tr className={cn('transition-colors hover:bg-accent/40', className)} {...props} />
}
