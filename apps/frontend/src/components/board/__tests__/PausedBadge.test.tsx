import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { PausedBadge } from '../PausedBadge'

describe('PausedBadge', () => {
  it('should render nothing when not paused', () => {
    const { container } = render(<PausedBadge paused={false} />)
    expect(container.firstChild).toBeNull()
  })

  it('should render badge when paused', () => {
    const { container } = render(
      <PausedBadge
        paused={true}
        pauseReason="Credits exhausted"
      />
    )
    expect(container.querySelector('span.font-medium')).toBeTruthy()
    expect(container.textContent).toContain('Paused')
  })

  it('should show retry info when retryAt is set', () => {
    const futureDate = new Date(Date.now() + 5 * 60 * 1000).toISOString()
    const { container } = render(
      <PausedBadge
        paused={true}
        pauseReason="Credits exhausted"
        pauseRetryAt={futureDate}
      />
    )
    expect(container.querySelector('span.font-medium')).toBeTruthy()
    expect(container.textContent).toContain('Paused')
  })
})
