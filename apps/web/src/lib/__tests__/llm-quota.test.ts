import { describe, expect, it, vi } from 'vitest'

vi.mock('../db', () => ({ db: {}, sql: () => 0 }))
import { DEFAULT_LLM_DAILY_MAX, llmDailyMax } from '../llm-quota'

describe('llmDailyMax', () => {
	it('defaults to 50 and accepts a non-negative integer', () => {
		expect(DEFAULT_LLM_DAILY_MAX).toBe(50)
		expect(llmDailyMax({} as NodeJS.ProcessEnv)).toBe(50)
		expect(llmDailyMax({ POWDER_LLM_DAILY_MAX: '7' } as unknown as NodeJS.ProcessEnv)).toBe(7)
		expect(llmDailyMax({ POWDER_LLM_DAILY_MAX: '0' } as unknown as NodeJS.ProcessEnv)).toBe(0)
		expect(llmDailyMax({ POWDER_LLM_DAILY_MAX: 'abc' } as unknown as NodeJS.ProcessEnv)).toBe(50)
		expect(llmDailyMax({ POWDER_LLM_DAILY_MAX: '-3' } as unknown as NodeJS.ProcessEnv)).toBe(50)
	})
})
