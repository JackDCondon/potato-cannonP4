// apps/frontend/src/hooks/use-resizable.ts
import { useState, useRef, useCallback, useEffect } from 'react'

interface UseResizableOptions {
  minWidth: number
  maxWidth: () => number
  defaultWidth: number
  snapWidth: () => number
  storageKey?: string
  disabled?: boolean
}

interface UseResizableReturn {
  width: number
  isDragging: boolean
  handleProps: {
    onMouseDown: (e: React.MouseEvent) => void
    onDoubleClick: (e: React.MouseEvent) => void
  }
}

export function useResizable({
  minWidth,
  maxWidth,
  defaultWidth,
  snapWidth,
  storageKey,
  disabled = false,
}: UseResizableOptions): UseResizableReturn {
  const getInitialWidth = () => {
    if (storageKey) {
      try {
        const stored = localStorage.getItem(storageKey)
        if (stored !== null) {
          const parsed = Number(stored)
          if (Number.isFinite(parsed)) {
            return Math.min(Math.max(parsed, minWidth), maxWidth())
          }
        }
      } catch {
        // Fall back to the configured default if storage is unavailable.
      }
    }

    return defaultWidth
  }

  const [width, setWidth] = useState(getInitialWidth)
  const [isDragging, setIsDragging] = useState(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(0)
  const widthRef = useRef(width)
  widthRef.current = width

  // Store refs for callback options so handlers stay stable across renders.
  const optsRef = useRef({ minWidth, maxWidth, snapWidth, defaultWidth })
  optsRef.current = { minWidth, maxWidth, snapWidth, defaultWidth }

  const handlersRef = useRef<{ move: (e: MouseEvent) => void; up: () => void } | null>(null)
  const setWidthAndPersist = useCallback(
    (nextWidth: number) => {
      setWidth(nextWidth)
      if (storageKey) {
        try {
          localStorage.setItem(storageKey, String(nextWidth))
        } catch {
          // Ignore storage failures; resizing should still work.
        }
      }
    },
    [storageKey]
  )

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (disabled) return
      if (handlersRef.current) return
      e.preventDefault()
      startXRef.current = e.clientX
      startWidthRef.current = widthRef.current
      setIsDragging(true)
      document.body.classList.add('is-resizing')

      const clamp = (value: number) =>
        Math.min(Math.max(value, optsRef.current.minWidth), optsRef.current.maxWidth())

      const move = (ev: MouseEvent) => {
        const delta = startXRef.current - ev.clientX
        setWidthAndPersist(clamp(startWidthRef.current + delta))
      }

      const up = () => {
        setIsDragging(false)
        document.body.classList.remove('is-resizing')
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
        handlersRef.current = null
      }

      handlersRef.current = { move, up }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    },
    [disabled]
  )

  const onDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (disabled) return
      e.preventDefault()
      const snap = optsRef.current.snapWidth()
      const isNearSnap = Math.abs(widthRef.current - snap) < 20
      setWidthAndPersist(isNearSnap ? optsRef.current.defaultWidth : snap)
    },
    [disabled, setWidthAndPersist]
  )

  // Cleanup on unmount (in case component unmounts mid-drag)
  useEffect(() => {
    return () => {
      document.body.classList.remove('is-resizing')
      if (handlersRef.current) {
        window.removeEventListener('mousemove', handlersRef.current.move)
        window.removeEventListener('mouseup', handlersRef.current.up)
        handlersRef.current = null
      }
    }
  }, [])

  return {
    width: disabled ? defaultWidth : width,
    isDragging,
    handleProps: { onMouseDown, onDoubleClick },
  }
}
