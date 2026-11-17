import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Shared fake `docker` for tests that run generated shell against a stub on PATH.
//
// The real CLI (docker 29.3.1 and 29.4.1) prints the rendered -f / --format
// template and then ONE extra "\n". Code that counts the lines of
// `docker inspect -f '{{range ...}}{{"\n"}}{{end}}'` sees labels+1 on a real
// container, and a fake without that newline would let a miscount pass the tests.
// So: `body` is the stub script (it prints the template output
// itself, e.g. `cat labels.txt` for a range template), saved as docker-impl, and
// `docker` is a wrapper that appends that "\n" after every successful
// `inspect -f/--format` call (`docker inspect`, `docker <object> inspect`), like
// the real binary. An `echo x` arm therefore
// prints "x\n\n", which is what the real CLI prints for a template ending in a
// newline; command substitution strips both, files and line counts keep them.
export function writeFakeDocker(dir: string, body: string): void {
	writeFileSync(join(dir, 'docker-impl'), body, { mode: 0o755 })
	writeFileSync(
		join(dir, 'docker'),
		`#!/bin/bash
__impl=${JSON.stringify(join(dir, 'docker-impl'))}
__fmt=0
case "$1 $2" in inspect\\ *|*\\ inspect) for __a in "$@"; do case "$__a" in -f|--format|-f=*|--format=*) __fmt=1 ;; esac; done ;; esac
if [ "$__fmt" = 1 ]; then "$__impl" "$@"; __rc=$?; if [ "$__rc" = 0 ]; then printf '\\n'; fi; exit "$__rc"; fi
exec "$__impl" "$@"
`,
		{ mode: 0o755 },
	)
}
