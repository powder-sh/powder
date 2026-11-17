// The AGENTS.md /new commits into an app's repo when the user ticks the checkbox
// (opt-in, default off) and the repo has none. Plain facts any reader of the
// repo (a person or a coding agent) needs: what a push does, where env vars
// live, how to check a deploy. Pure, so it is unit-tested.

import { SITE_URL } from './site'

export const AGENTS_MD_PATH = 'AGENTS.md'
export const AGENTS_MD_COMMIT_MESSAGE = 'chore: add AGENTS.md describing the powder deploy'

export function renderAgentsMd(p: { branch: string; dashboardUrl: string }): string {
	const dash = p.dashboardUrl.replace(/\/+$/, '')
	return `# Deploys

This app is deployed by powder: ${SITE_URL}

## What a push does

\`git push origin ${p.branch}\` sends a webhook to powder, which:

1. clones this repo fresh on the app's server,
2. builds the image there from this repo's \`Dockerfile\` (no CI and no registry needed),
3. starts the new container, health-checks it, and swaps it in. If the build or the health check fails, the old version keeps serving.

The \`Dockerfile\` is the build: anything that fails it (a type or lint error in the build step, for example) fails the deploy.

Deploy by pushing. A build run by hand on the server bypasses powder's checks and leaves no rollback tag.

## Env vars

Env vars live in powder: ${dash}/projects, open this app, then the env tab. The env file on the server is generated from powder on every deploy, so edits made directly on the server are overwritten.

## Checking a deploy

- The app's deployments tab in powder shows each deploy with its live output.
- The logs tab shows the running container's output.
- Rollback: revert the commit and push, or roll back to an earlier deploy from the app's container page in powder.

Docs: ${SITE_URL}/docs/deploys
`
}
