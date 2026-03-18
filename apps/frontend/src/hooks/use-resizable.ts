// apps/frontend/src/hooks/use-resizable.ts
import { useState, useRef, useCallback, useEffect } from 'react'

interface UseResizableOptions {
  minWidth: number
  maxWidth: () => number
  defaultWidth: number
  snapWidth: () => number
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
  disabled = false,
}: UseResizableOptions): UseResizableReturn {
  const [width, setWidth] = useState(defaultWidth)
  const [isDragging, setIsDragging] = useState(false)
  const startXRef = useRef(0)
  const startWidthRef = useRef(0)

  // Store listeners in refs so cleanup always removes the correct identity,
  // regardless of how often maxWidth/minWidth callbacks change between renders.
  const handlersRef = useRef<{ move: (e: MouseEvent) => void; up: () => void } | null>(null)

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (disabled) return
      e.preventDefault()
      startXRef.current = e.clientX
      startWidthRef.current = width
      setIsDragging(true)
      document.body.classList.add('is-resizing')

      const clamp = (value: number) => Math.min(Math.max(value, minWidth), maxWidth())

      const move = (ev: MouseEvent) => {
        const delta = startXRef.current - ev.clientX
        setWidth(clamp(startWidthRef.current + delta))
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
    [disabled, width, minWidth, maxWidth]
  )

  const onDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (disabled) return
      e.preventDefault()
      const snap = snapWidth()
      const isNearSnap = Math.abs(width - snap) < 20
      setWidth(isNearSnap ? defaultWidth : snap)
    },
    [disabled, width, snapWidth, defaultWidth]
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
