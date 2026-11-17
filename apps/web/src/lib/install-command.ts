// The install commands, one source for the landing page and the docs. The release
// tag follows the version in the root package.json, baked in by next.config.ts.
// README.md, content/docs/quickstart.md and content/docs/self-hosting.md carry the
// same lines literally (readable on GitHub): install-command-literals.test.ts keeps
// them equal to installLines(<package.json version>), and the maintainers' release
// tooling rewrites them when it bumps the version.

import { PUBLIC_REPO_URL } from './site'

export function installLines(version: string): readonly string[] {
	return [
		`sudo git clone --branch v${version} ${PUBLIC_REPO_URL} /opt/apps/powder/src`,
		'cd /opt/apps/powder/src',
		'sudo bin/install.sh',
	]
}

export const INSTALL_LINES: readonly string[] = installLines(process.env.NEXT_PUBLIC_POWDER_VERSION ?? '0.0.0')
