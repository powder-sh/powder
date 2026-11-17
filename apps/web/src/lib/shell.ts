// a container name starts with a letter or digit (Docker's own rule), so
// it can never be read as an option of the docker command it is passed to.
export const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/

export function assertSafeName(name: string): string {
	if (!SAFE_NAME.test(name)) throw new Error(`unsafe container name: ${name}`)
	return name
}

export function shq(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`
}

/** Single-quote a value for a POSIX shell command line. */
export function shellQuote(s: string): string {
	return shq(s)
}
