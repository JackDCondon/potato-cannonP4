import { beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { GlobalConfigurePage } from './global-configure'

const getGlobalConfig = vi.fn()
const updatePerforceGlobalConfig = vi.fn()
const updateAiGlobalConfig = vi.fn()

vi.mock('@/api/client', () => ({
  api: {
    getGlobalConfig: (...args: unknown[]) => getGlobalConfig(...args),
    updatePerforceGlobalConfig: (...args: unknown[]) => updatePerforceGlobalConfig(...args),
    updateAiGlobalConfig: (...args: unknown[]) => updateAiGlobalConfig(...args),
  },
}))

vi.mock('@tanstack/react-router', () => ({
  createFileRoute: () => () => ({}),
}))

vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}))

describe('GlobalConfigurePage', () => {
  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    getGlobalConfig.mockResolvedValue({
      perforce: { mcpServerPath: 'C:/p4/mcp.js' },
      ai: {
        defaultProvider: 'anthropic',
        providers: [
          { id: 'anthropic', models: { low: 'haiku', mid: 'sonnet', high: 'opus' } },
          { id: 'openai', models: { low: 'gpt-4o-mini', mid: 'gpt-4.1', high: 'o3' } },
        ],
      },
    })
    updatePerforceGlobalConfig.mockResolvedValue({ ok: true, perforce: { mcpServerPath: 'C:/p4/mcp.js' } })
    updateAiGlobalConfig.mockResolvedValue({ ok: true })
  })

  it('loads and renders perforce and ai config controls', async () => {
    render(<GlobalConfigurePage />)

    await waitFor(() => {
      expect(screen.getByLabelText('Perforce MCP Server Path')).toBeInTheDocument()
    })

    expect(screen.getByDisplayValue('C:/p4/mcp.js')).toBeInTheDocument()
    expect(screen.getByLabelText('Default Provider')).toBeInTheDocument()
    expect((screen.getByLabelText('Default Provider') as HTMLSelectElement).value).toBe('anthropic')
    expect(screen.getAllByLabelText('Provider ID').length).toBeGreaterThan(0)
  })

  it('saves updated ai provider config', async () => {
    render(<GlobalConfigurePage />)

    await waitFor(() => {
      expect(screen.getByLabelText('Default Provider')).toBeInTheDocument()
    })

    fireEvent.change(screen.getByLabelText('Default Provider'), {
      target: { value: 'openai' },
    })

    const highInput = document.getElementById('provider-high-1') as HTMLInputElement
    expect(highInput).toBeTruthy()
    fireEvent.change(highInput, { target: { value: 'o4' } })

    fireEvent.click(screen.getAllByRole('button', { name: 'Save Global Settings' })[0])

    await waitFor(() => {
      expect(updateAiGlobalConfig).toHaveBeenCalledWith({
        defaultProvider: 'openai',
        providers: [
          { id: 'anthropic', models: { low: 'haiku', mid: 'sonnet', high: 'opus' } },
          { id: 'openai', models: { low: 'gpt-4o-mini', mid: 'gpt-4.1', high: 'o4' } },
        ],
      })
    })
  })
})
