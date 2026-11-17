import type { ButtonHTMLAttributes } from 'react'
import { type ButtonSize, type ButtonVariant, buttonVariants } from './button-variants'
import { Spinner } from './spinner'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: ButtonVariant
	size?: ButtonSize
	// Shows a spinner, disables the button and sets aria-busy. Keep the label:
	// the button should say what is happening ("deploying…").
	loading?: boolean
}

export function Button({
	className,
	variant = 'default',
	size = 'default',
	loading = false,
	disabled,
	children,
	...props
}: ButtonProps) {
	return (
		<button
			className={buttonVariants({ variant, size, className })}
			disabled={disabled || loading}
			aria-busy={loading || undefined}
			{...props}
		>
			{loading && <Spinner />}
			{children}
		</button>
	)
}
