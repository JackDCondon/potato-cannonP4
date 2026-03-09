import { useState, useEffect } from 'react'
import { Monitor, Loader2, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { api } from '@/api/client'
import { useRemoteControlSSE } from '@/hooks/useSSE'

interface RemoteControlButtonProps {
  projectId: string
  ticketId: string
  ticketTitle: string
  hasActiveSession: boolean
}

type RCState = 'idle' | 'pending' | 'active'

export function RemoteControlButton({
  projectId,
  ticketId,
  ticketTitle,
  hasActiveSession,
}: RemoteControlButtonProps) {
  const [state, setState] = useState<RCState>('idle')
  const [url, setUrl] = useState<string | null>(null)

  // On mount (and reconnect), fetch the current RC state in case it was already started
  const fetchInitialState = () => {
    api.getRemoteControl(projectId, ticketId)
      .then((rc) => {
        if (rc.url) {
          setUrl(rc.url)
          setState('active')
        } else if (rc.pending) {
          setState('pending')
        } else {
          setState('idle')
          setUrl(null)
        }
      })
      .catch(() => {
        // Ignore fetch errors — keep current state
      })
  }

  useEffect(() => {
    if (!hasActiveSession) {
      setState('idle')
      setUrl(null)
      return
    }
    fetchInitialState()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, ticketId, hasActiveSession])

  useRemoteControlSSE(
    ticketId,
    (rcUrl) => {
      setUrl(rcUrl)
      setState('active')
    },
    () => {
      setUrl(null)
      setState('idle')
    },
    () => {
      // SSE reconnected — re-fetch to recover any missed state
      fetchInitialState()
    },
  )

  const handleStart = async () => {
    setState('pending')
    try {
      await api.startRemoteControl(projectId, ticketId, ticketTitle)
    } catch {
      setState('idle')
    }
  }

  if (state === 'active' && url) {
    return (
      <div className="flex items-center gap-2">
        <Monitor className="h-4 w-4 text-accent flex-shrink-0" />
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-accent hover:underline flex items-center gap-1"
        >
          Open in Claude.ai
          <ExternalLink className="h-3 w-3" />
        </a>
      </div>
    )
  }

  return (
    <Button
      variant="outline"
      size="sm"
      disabled={!hasActiveSession || state === 'pending'}
      onClick={handleStart}
      className="gap-2"
    >
      {state === 'pending' ? (
        <Loader2 className="h-4 w-4 animate-spin" />
      ) : (
        <Monitor className="h-4 w-4" />
      )}
      {state === 'pending' ? 'Connecting…' : 'Start Remote Control'}
    </Button>
  )
}
