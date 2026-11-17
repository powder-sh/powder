import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { protectExistingIgnoreShell } from '../app-runtime-files'
import { composeDockerfileRewriteShell, dockerfileRewriteFunctions } from '../build-cache'
import { serviceImageLabelGuardShell } from '../deploy/fragments'
import { writeFakeDocker } from './fixtures/fake-docker'

// The per-deploy override set is swapped into dfr/ during preflight, before the
// build and before the image-label step writes labels.yml. So a build that fails in
// between does not leave the running container's config_files label naming a missing
// dfr/labels.yml (powder-migrate resolve_dburl, a hand-run compose), the new set
// carries an empty, valid labels.yml from the swap on.

const NS = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
const root = mkdtempSync(join(tmpdir(), 'dfrl-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const bin = join(root, 'bin')
mkdirSync(bin)
writeFakeDocker(bin, '#!/bin/bash\n# the base image ONBUILD check (dfr_bases): no triggers\nif [[ "$*" == *".Config.OnBuild"* ]]; then echo 0; exit 0; fi\n# image IDs and configs for the provenance check (dfr_prov)\nif [[ "$*" == *"{{.Id}}"* ]]; then echo "sha256:$(printf %s "${@: -1}" | cksum | cut -d" " -f1)"; exit 0; fi\nif [[ "$*" == *"{{json .Config}}"* ]]; then echo "{}"; exit 0; fi\nif [[ "$*" == *"range .RepoDigests"* ]]; then r="${@: -1}"; r="${r%%@*}"; case "${r##*/}" in *:*) r="${r%:*}";; esac; echo "$r@sha256:0000000000000000000000000000000000000000000000000000000000000000"; exit 0; fi\nif [ "$1" = pull ]; then exit 0; fi\nif [[ "$*" == *" config" ]]; then cat "$CFG"; exit 0; fi\nexit 1\n')

describe('dfr/labels.yml exists from the swap on', () => {
	it('preflight alone (the build then fails) leaves a valid empty labels.yml in dfr/', () => {
		const ctx = join(root, 'src')
		mkdirSync(ctx)
		writeFileSync(join(ctx, 'Dockerfile'), 'FROM x\n')
		const cfg = join(root, 'cfg.yml')
		writeFileSync(
			cfg,
			`name: shop\nservices:\n  app:\n    build:\n      context: ${ctx}\n      dockerfile: Dockerfile\n    image: shop:latest\n`,
		)
		const final = join(root, 'state', 'k', 'dfr')
		mkdirSync(join(root, 'state', 'k'), { recursive: true })
		// an old set from the previous deploy, with its labels.yml
		mkdirSync(final)
		writeFileSync(join(final, 'labels.yml'), 'services:\n  db:\n    pull_policy: missing\n')
		const script = `set -e; DFR_NS=${NS}; DFR_APP=shop; DFR_FINAL=${JSON.stringify(final)}; DFR_DIR="$DFR_FINAL.new"; mkdir -m 700 "$DFR_DIR"; DFR_MODE=warn; DFR_PULL=1; DFR_OWN=""; ${dockerfileRewriteFunctions('shop')}${composeDockerfileRewriteShell("-f 'x.yml'", protectExistingIgnoreShell)}echo "DIR=$DFR_DIR"; exit 3`
		const r = spawnSync('bash', ['-c', script], {
			encoding: 'utf8',
			env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CFG: cfg },
		})
		expect(r.status, r.stdout + r.stderr).toBe(3)
		expect(r.stdout).toContain(`DIR=${final}`)
		expect(existsSync(join(final, 'override.yml'))).toBe(true)
		expect(readFileSync(join(final, 'labels.yml'), 'utf8')).toBe('services: {}\n')
		expect(existsSync(`${final}.new`)).toBe(false)
	})
	it('the image-label step keeps the file valid when it pins nothing', () => {
		expect(serviceImageLabelGuardShell("-f 'x.yml'", "-f 'x.yml'", 'app', '')).toContain(
			`else printf 'services: {}\n' > "$LB_OV"; fi`,
		)
	})
})
