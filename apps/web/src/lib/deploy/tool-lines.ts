// Fixed words of lines the deploy scripts print and the failure summary
// (lib/deploy-failure.ts) reads. A leaf module (no imports): the script builders
// and the reader take the same constant, so a reworded line cannot drift away
// from the rule that reads it. The contract tests render the scripts and check
// that every line they print before a non-zero exit is still recognised.

/** The git-auth preflight's line when `git ls-remote` fails (deploy/script.ts,
 *  deploy/self-deploy.ts). The script appends ` - ... remote=<url> :: <last lines
 *  of the git output>`; those last lines are cut, so the reader matches these words. */
export const GIT_REMOTE_UNREADABLE = 'preflight: cannot read the git remote'
