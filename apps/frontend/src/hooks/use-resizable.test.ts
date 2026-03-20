// apps/frontend/src/hooks/use-resizable.test.ts
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useResizable } from './use-resizable'

const baseOpts = {
  minWidth: 480,
  maxWidth: () => 1600,
  defaultWidth: 480,
  snapWidth: () => 800,
}

describe('useResizable', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
  })

  test('returns default width initially', () => {
    const { result } = renderHook(() => useResizable(baseOpts))
    expect(result.current.width).toBe(480)
    expect(result.current.isDragging).toBe(false)
  })

  test('double-click toggles between default and snap width', () => {
    const { result } = renderHook(() => useResizable(baseOpts))
    act(() => {
      result.current.handleProps.onDoubleClick({
        preventDefault: () => {},
      } as unknown as React.MouseEvent)
    })
    expect(result.current.width).toBe(800)
    act(() => {
      result.current.handleProps.onDoubleClick({
        preventDefault: () => {},
      } as unknown as React.MouseEvent)
    })
    expect(result.current.width).toBe(480)
  })

  test('disabled mode returns default width and noop handlers', () => {
    const { result } = renderHook(() =>
      useResizable({ ...baseOpts, disabled: true })
    )
    expect(result.current.width).toBe(480)
    act(() => {
      result.current.handleProps.onMouseDown({
        clientX: 500,
        preventDefault: () => {},
      } as unknown as React.MouseEvent)
    })
    expect(result.current.isDragging).toBe(false)
  })

  test('reads initial width from localStorage when storageKey is provided', () => {
    localStorage.setItem('potato-panel-width', '550')

    const { result } = renderHook(() =>
      useResizable({ ...baseOpts, storageKey: 'potato-panel-width' })
    )

    expect(result.current.width).toBe(550)
  })

  test('clamps stored width to minWidth when storageKey is provided', () => {
    localStorage.setItem('potato-panel-width', '100')

    const { result } = renderHook(() =>
      useResizable({ ...baseOpts, storageKey: 'potato-panel-width' })
    )

    expect(result.current.width).toBe(480)
  })

  test('persists drag updates to localStorage when storageKey is provided', () => {
    const { result } = renderHook(() =>
      useResizable({ ...baseOpts, storageKey: 'potato-panel-width' })
    )

    act(() => {
      result.current.handleProps.onMouseDown({
        clientX: 500,
        preventDefault: () => {},
      } as unknown as React.MouseEvent)
    })

    act(() => {
      window.dispatchEvent(new MouseEvent('mousemove', { clientX: 300 }))
    })

    expect(localStorage.getItem('potato-panel-width')).toBe('680')

    act(() => {
      window.dispatchEvent(new MouseEvent('mouseup'))
    })
  })

  describe('drag behavior', () => {
    beforeEach(() => {
      vi.stubGlobal('innerWidth', 1920)
    })
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    test('mousedown starts drag, mousemove updates width, mouseup ends drag', () => {
      const { result } = renderHook(() => useResizable(baseOpts))

      // Start drag at x=500
      act(() => {
        result.current.handleProps.onMouseDown({
          clientX: 500,
          preventDefault: () => {},
        } as unknown as React.MouseEvent)
      })
      expect(result.current.isDragging).toBe(true)
      expect(document.body.classList.contains('is-resizing')).toBe(true)

      // Move left by 200px (increases panel width by 200)
      act(() => {
        window.dispatchEvent(
          new MouseEvent('mousemove', { clientX: 300 })
        )
      })
      expect(result.current.width).toBe(680)

      // Release
      act(() => {
        window.dispatchEvent(new MouseEvent('mouseup'))
      })
      expect(result.current.isDragging).toBe(false)
      expect(document.body.classList.contains('is-resizing')).toBe(false)
    })

    test('clamps width to minWidth', () => {
      const { result } = renderHook(() => useResizable(baseOpts))

      act(() => {
        result.current.handleProps.onMouseDown({
          clientX: 500,
          preventDefault: () => {},
        } as unknown as React.MouseEvent)
      })

      // Move right by 200px (would decrease width below min)
      act(() => {
        window.dispatchEvent(
          new MouseEvent('mousemove', { clientX: 700 })
        )
      })
      expect(result.current.width).toBe(480) // clamped to min

      act(() => {
        window.dispatchEvent(new MouseEvent('mouseup'))
      })
    })

    test('clamps width to maxWidth', () => {
      const { result } = renderHook(() => useResizable(baseOpts))

      act(() => {
        result.current.handleProps.onMouseDown({
          clientX: 500,
          preventDefault: () => {},
        } as unknown as React.MouseEvent)
      })

      // Move left by 2000px (would exceed max)
      act(() => {
        window.dispatchEvent(
          new MouseEvent('mousemove', { clientX: -1500 })
        )
      })
      expect(result.current.width).toBe(1600) // clamped to max

      act(() => {
        window.dispatchEvent(new MouseEvent('mouseup'))
      })
    })
  })
})
