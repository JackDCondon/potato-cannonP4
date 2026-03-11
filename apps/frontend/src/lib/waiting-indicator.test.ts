import { describe, expect, it } from 'vitest'
import { getWaitingIndicatorLabel, isAwaitingUserInput } from './waiting-indicator'

describe('isAwaitingUserInput', () => {
  it('returns true when the latest message is a question', () => {
    expect(
      isAwaitingUserInput([
        { type: 'user' },
        { type: 'question' }
      ])
    ).toBe(true)
  })

  it('returns false when the latest message is not a question', () => {
    expect(
      isAwaitingUserInput([
        { type: 'question' },
        { type: 'user' }
      ])
    ).toBe(false)
  })
})

describe('getWaitingIndicatorLabel', () => {
  it('prefers tool activity text when present', () => {
    expect(getWaitingIndicatorLabel('Reviewing files', true)).toBe('Reviewing files')
  })

  it('shows waiting copy when awaiting user input', () => {
    expect(getWaitingIndicatorLabel(null, true)).toBe('Waiting for your response')
  })

  it('falls back to Thinking while actively processing', () => {
    expect(getWaitingIndicatorLabel(null, false)).toBe('Thinking')
  })
})
