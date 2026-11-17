// one constant for the postgres client image that receives DB passwords and dumps
// (`docker run --network host --env-file ...`). A moving tag means whoever controls the tag
// receives those. Pin it by digest.
//
// Default is pinned by digest. To move it,
// resolve a new digest with
//   docker buildx imagetools inspect postgres:17-alpine --format '{{.Manifest.Digest}}'
// and update the constant, or set POWDER_PG_TOOL_IMAGE on the powder service (it wins).
export const POSTGRES_TOOL_IMAGE_DEFAULT =
	'postgres:17-alpine@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b'

const IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*(:[A-Za-z0-9._-]+)?(@sha256:[0-9a-f]{64})?$/

export function postgresToolImage(env: NodeJS.ProcessEnv = process.env): string {
	const v = env.POWDER_PG_TOOL_IMAGE?.trim()
	return v && IMAGE_REF.test(v) ? v : POSTGRES_TOOL_IMAGE_DEFAULT
}

export const isDigestPinned = (ref: string) => /@sha256:[0-9a-f]{64}$/.test(ref)
