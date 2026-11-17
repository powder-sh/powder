import { githubOAuthConfigured } from '@/lib/github-oauth'
import { LoginForm } from './login-form'

// Per request, not at build: whether GitHub sign-in is configured is runtime env.
export const dynamic = 'force-dynamic'

export default function LoginPage() {
	return <LoginForm github={githubOAuthConfigured()} />
}
