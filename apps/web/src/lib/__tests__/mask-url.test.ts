import { describe, expect, it } from 'vitest'
import { maskUrlPassword } from '../secret-mask'

describe('maskUrlPassword', () => {
	it('masks a normal password and keeps the rest', () => {
		expect(maskUrlPassword('postgres://app:s3cret@db:5432/app?sslmode=require')).toBe('postgres://app:****@db:5432/app?sslmode=require')
	})
	it('@ in the password does not leak the tail', () => {
		const m = maskUrlPassword('postgres://app:p@ss:w0rd@db:5432/app') ?? ''
		expect(m).not.toContain('ss')
		expect(m).not.toContain('w0rd')
		expect(m).toContain('@db:5432/app')
	})
	it('masks ?password= and similar query params, keeps harmless ones', () => {
		const m = maskUrlPassword('postgres://app@db/app?password=hunter2&sslmode=require&apikey=abc') ?? ''
		expect(m).not.toContain('hunter2')
		expect(m).not.toContain('abc')
		expect(m).toContain('sslmode=require')
	})
	it('a keyword DSN or garbage is masked entirely', () => {
		expect(maskUrlPassword('host=db user=app password=hunter2 dbname=app')).toBe('****')
		expect(maskUrlPassword('not a url')).toBe('****')
		expect(maskUrlPassword('')).toBe('****')
	})
	it('null stays null; a URL without userinfo is unchanged', () => {
		expect(maskUrlPassword(null)).toBeNull()
		expect(maskUrlPassword('postgres://db:5432/app')).toBe('postgres://db:5432/app')
	})
	it('a username with no password is masked (the token-as-user form)', () => {
		const m = maskUrlPassword('redis://tok3nV4lue@cache:6379/0') ?? ''
		expect(m).not.toContain('tok3nV4lue')
		expect(m).toBe('redis://****@cache:6379/0')
		expect(maskUrlPassword('postgres://app@db:5432/app')).toBe('postgres://****@db:5432/app')
		expect(maskUrlPassword('redis://:s3cret@cache:6379')).toBe('redis://:****@cache:6379')
	})
})
