import { cn } from '@/lib/cn'
import { ChevronDown } from 'lucide-react'
import {
	Children,
	type CSSProperties,
	cloneElement,
	type InputHTMLAttributes,
	isValidElement,
	type ReactElement,
	type ReactNode,
	type SelectHTMLAttributes,
	type TextareaHTMLAttributes,
	useId,
} from 'react'

// Shared field chrome. Inputs, selects and textareas look the same everywhere.
export const fieldClasses =
	'w-full rounded-md border border-input bg-card text-base text-foreground sm:text-sm transition-colors placeholder:text-muted-foreground/80 hover:border-border-strong focus-visible:outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-destructive aria-[invalid=true]:focus-visible:ring-destructive/30'

// 40px tall on phones (tap target), denser from sm up.
const fieldSizes = {
	default: 'h-10 px-3 sm:h-9',
	sm: 'h-10 px-2.5 sm:h-8',
} as const

// The font size of every field, per size: 16px below sm (iOS Safari zooms the
// page into a focused field set smaller), denser from sm up. Input, Select and
// Textarea apply it after the caller's className, so a page cannot shrink it.
export const fieldText = {
	default: 'text-base sm:text-sm',
	sm: 'text-base sm:text-xs',
} as const

interface FieldProps {
	id: string
	label?: ReactNode
	hint?: ReactNode
	error?: ReactNode
	children: ReactNode
	className?: string
}

// Label + control + hint/error, wired with ids for screen readers. A grid, so a
// FieldRow can put its label and its control on rows shared with its neighbours.
export function Field({ id, label, hint, error, children, className }: FieldProps) {
	return (
		<div className={cn('grid content-start gap-1.5', className)}>
			{label && (
				<label htmlFor={id} className="block text-xs font-medium text-foreground">
					{label}
				</label>
			)}
			{children}
			{error ? (
				<p id={`${id}-msg`} className="text-xs text-destructive">
					{error}
				</p>
			) : hint ? (
				<p id={`${id}-msg`} className="text-xs text-muted-foreground">
					{hint}
				</p>
			) : null}
		</div>
	)
}

interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
	label?: ReactNode
	hint?: ReactNode
	error?: string
	inputSize?: keyof typeof fieldSizes
}

export function Input({
	className,
	label,
	hint,
	error,
	id,
	inputSize = 'default',
	...props
}: InputProps) {
	const auto = useId()
	const fid = id ?? auto
	const field = (
		<input
			id={fid}
			aria-invalid={error ? true : undefined}
			aria-describedby={error || hint ? `${fid}-msg` : undefined}
			className={cn(fieldClasses, fieldSizes[inputSize], className, fieldText[inputSize])}
			{...props}
		/>
	)
	if (!label && !error && !hint) return field
	return (
		<Field id={fid} label={label} hint={hint} error={error}>
			{field}
		</Field>
	)
}

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
	selectSize?: keyof typeof fieldSizes
	/** Classes for the <select> itself. `className` sizes the wrapper (width, flex). */
	selectClassName?: string
}

// Native <select> (keyboard, screen readers and phone pickers come free) with
// the field chrome and our own chevron. The browser arrow is removed with
// appearance-none; right padding reserves room so long option text truncates
// before it reaches the icon.
const selectPadding = {
	default: 'pr-9',
	sm: 'pr-8',
} as const

export function Select({
	className,
	selectClassName,
	selectSize = 'default',
	children,
	...props
}: SelectProps) {
	return (
		<span className={cn('relative inline-flex min-w-0 max-w-full align-middle', className)}>
			<select
				className={cn(
					fieldClasses,
					fieldSizes[selectSize],
					selectPadding[selectSize],
					'peer min-w-0 cursor-pointer appearance-none truncate disabled:cursor-not-allowed',
					selectClassName,
					fieldText[selectSize],
				)}
				{...props}
			>
				{children}
			</select>
			<ChevronDown
				aria-hidden="true"
				className={cn(
					'pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted-foreground transition-colors peer-hover:text-foreground peer-focus-visible:text-foreground peer-disabled:opacity-50',
					selectSize === 'sm' ? 'right-2 h-3.5 w-3.5' : 'right-2.5 h-4 w-4',
				)}
			/>
		</span>
	)
}

interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
	textareaSize?: keyof typeof fieldText
}

// Multi-line field with the same chrome and font sizes as Input.
export function Textarea({ className, textareaSize = 'default', ...props }: TextareaProps) {
	return (
		<textarea
			className={cn(fieldClasses, 'block px-3 py-2', className, fieldText[textareaSize])}
			{...props}
		/>
	)
}

interface FieldRowProps {
	/** Labelled fields: <Input label=…> or <Field>. No hint/error on them: the row has one. */
	children: ReactNode
	/** Buttons that act on the row. They sit on the control line, after the fields. */
	action?: ReactNode
	/** One message for the whole row, under it. An error replaces the hint. */
	hint?: ReactNode
	error?: ReactNode
	id?: string
	className?: string
	/**
	 * grid-template-columns for the fields when inline, e.g. 'minmax(0,1fr) 8rem'.
	 * Default: equal widths. The action column is appended (auto width).
	 */
	columns?: string
}

// The one layout for inline forms: label + control (+ more fields) + action.
// Inline, each field spans two rows of the row's grid (subgrid), so every label
// sits on one top line and every control on one line whatever the label lengths,
// and the action sits on the control line at the controls' height. The message
// takes a third row across the whole width, so a hint or an error never moves
// anything above it. Rows with more than one field stack when the row's own width
// is under 36rem (fields, then the message, then the action); a single field
// keeps its action beside it.
export function FieldRow({ children, action, hint, error, id, className, columns }: FieldRowProps) {
	const auto = useId()
	const msgId = `${id ?? auto}-msg`
	const message = error || hint
	const fields = Children.toArray(children).filter(isValidElement)
	const stack = fields.length > 1
	const template = `${columns ?? `repeat(${fields.length}, minmax(0, 1fr))`}${action ? ' auto' : ''}`
	// The container query reads the wrapper's width: an element cannot query itself.
	return (
		<div className={cn('@container', className)}>
			<div
				style={{ '--row-cols': template } as CSSProperties}
				className={cn(
					'grid gap-x-2',
					// The row gap equals Field's label/control gap: a subgrid with a
					// different gap would shift its items off the shared lines.
					stack
						? 'gap-y-3 @xl:gap-y-1.5 @xl:[grid-template-columns:var(--row-cols)] @xl:[&>:not([data-row-part])]:row-span-2 @xl:[&>:not([data-row-part])]:grid-rows-subgrid'
						: 'gap-y-1.5 [grid-template-columns:var(--row-cols)] [&>:not([data-row-part])]:row-span-2 [&>:not([data-row-part])]:grid-rows-subgrid',
				)}
			>
				{fields.map((f) => {
					if (!message || f.type !== Input) return f
					const props = f.props as InputProps
					const extra: Partial<InputProps> = {}
					if (!props['aria-describedby']) extra['aria-describedby'] = msgId
					if (error && !('aria-invalid' in props)) extra['aria-invalid'] = true
					return Object.keys(extra).length > 0
						? cloneElement(f as ReactElement<InputProps>, extra)
						: f
				})}
				{message && (
					<p
						id={msgId}
						role={error ? 'alert' : undefined}
						data-row-part=""
						className={cn(
							'text-xs',
							error ? 'text-destructive' : 'text-muted-foreground',
							stack ? '-mt-1.5 @xl:mt-0 @xl:[grid-area:3/1/4/-1]' : '[grid-area:3/1/4/-1]',
						)}
					>
						{message}
					</p>
				)}
				{action && (
					<div
						data-row-part=""
						className={cn(
							'flex items-center gap-2',
							stack ? '@xl:[grid-area:2/-2/3/-1]' : '[grid-area:2/-2/3/-1]',
						)}
					>
						{action}
					</div>
				)}
			</div>
		</div>
	)
}
