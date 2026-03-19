import { useEffect, useState, useMemo, useCallback } from 'react'
import { toast } from 'sonner'
import { RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettingsSection } from './SettingsSection'
import { PmModeSelector } from './PmModeSelector'
import { PmAlertToggles } from './PmAlertToggles'
import { api } from '@/api/client'
import type { PmConfig, PmMode, PmAlertConfig, PmPollingConfig } from '@potato-cannon/shared'
import { DEFAULT_PM_CONFIG } from '@potato-cannon/shared'

interface BoardSettingsPageProps {
  projectId: string
  workflowId: string
}

export function BoardSettingsPage({ projectId, workflowId }: BoardSettingsPageProps) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // Current form state
  const [mode, setMode] = useState<PmMode>(DEFAULT_PM_CONFIG.mode)
  const [polling, setPolling] = useState<PmPollingConfig>({ ...DEFAULT_PM_CONFIG.polling })
  const [alerts, setAlerts] = useState<PmAlertConfig>({ ...DEFAULT_PM_CONFIG.alerts })

  // Snapshot of last-saved state for dirty checking
  const [savedSnapshot, setSavedSnapshot] = useState('')

  const currentConfig = useMemo<PmConfig>(
    () => ({ mode, polling, alerts }),
    [mode, polling, alerts],
  )

  const currentSnapshot = useMemo(
    () => JSON.stringify(currentConfig),
    [currentConfig],
  )

  const hasChanges = currentSnapshot !== savedSnapshot

  // ---------- Helpers ----------

  const applyConfig = useCallback((config: PmConfig) => {
    setMode(config.mode)
    setPolling({ ...config.polling })
    setAlerts({ ...config.alerts })
  }, [])

  // ---------- Load ----------

  useEffect(() => {
    let cancelled = false

    api.getBoardSettings(projectId, workflowId)
      .then(({ pmConfig }) => {
        if (cancelled) return
        applyConfig(pmConfig)
        setSavedSnapshot(JSON.stringify(pmConfig))
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : 'Failed to load board settings'
        toast.error(message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [projectId, workflowId, applyConfig])

  const handlePollingChange = useCallback(
    (field: keyof PmPollingConfig, raw: string) => {
      const parsed = parseInt(raw, 10)
      if (!Number.isNaN(parsed) && parsed >= 1) {
        setPolling((prev) => ({ ...prev, [field]: parsed }))
      } else if (raw === '') {
        // Allow clearing the field for typing convenience; validation on save
        setPolling((prev) => ({ ...prev, [field]: 0 }))
      }
    },
    [],
  )

  // ---------- Save ----------

  const save = useCallback(async () => {
    // Validate polling values
    if (polling.intervalMinutes < 1 || polling.stuckThresholdMinutes < 1 || polling.alertCooldownMinutes < 1) {
      toast.error('Polling values must be at least 1 minute')
      return
    }

    setSaving(true)
    try {
      const { pmConfig } = await api.updateBoardPmSettings(projectId, workflowId, currentConfig)
      applyConfig(pmConfig)
      setSavedSnapshot(JSON.stringify(pmConfig))
      toast.success('Board settings saved')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save board settings'
      toast.error(message)
    } finally {
      setSaving(false)
    }
  }, [projectId, workflowId, currentConfig, applyConfig, polling])

  // ---------- Reset ----------

  const resetToDefaults = useCallback(async () => {
    setSaving(true)
    try {
      const { pmConfig } = await api.resetBoardPmSettings(projectId, workflowId)
      applyConfig(pmConfig)
      setSavedSnapshot(JSON.stringify(pmConfig))
      toast.success('Board settings reset to defaults')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to reset board settings'
      toast.error(message)
    } finally {
      setSaving(false)
    }
  }, [projectId, workflowId, applyConfig])

  // ---------- Render ----------

  const isPassive = mode === 'passive'

  return (
    <div className="@container h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto p-6 pb-12">
        <div className="space-y-2">
          <SettingsSection
            title="PM Mode"
            description="Choose how the Project Manager operates on this board."
          >
            <PmModeSelector
              value={mode}
              onChange={setMode}
              disabled={loading || saving}
            />
          </SettingsSection>

          <SettingsSection
            title="Alert Categories"
            description="Enable or disable specific alert types. Greyed out in passive mode."
          >
            <PmAlertToggles
              value={alerts}
              onChange={setAlerts}
              disabled={loading || saving || isPassive}
            />
            {isPassive && (
              <p className="mt-3 text-xs text-text-secondary">
                Alerts are inactive in passive mode. Switch to watching or executing to configure.
              </p>
            )}
          </SettingsSection>

          <SettingsSection
            title="Polling Configuration"
            description="Timing parameters for the daemon-side polling loop. Only active in watching or executing mode."
          >
            <div className="space-y-4 max-w-md">
              <div className="space-y-1">
                <label className="text-sm font-medium text-text-primary" htmlFor="poll-interval">
                  Poll Interval (minutes)
                </label>
                <Input
                  id="poll-interval"
                  type="number"
                  min={1}
                  value={polling.intervalMinutes || ''}
                  onChange={(e) => handlePollingChange('intervalMinutes', e.target.value)}
                  disabled={loading || saving || isPassive}
                />
                <p className="text-sm text-text-secondary">
                  How often the poller checks for issues.
                </p>
              </div>

              <div className="space-y-1">
                <label className="text-sm font-medium text-text-primary" htmlFor="stuck-threshold">
                  Stuck Threshold (minutes)
                </label>
                <Input
                  id="stuck-threshold"
                  type="number"
                  min={1}
                  value={polling.stuckThresholdMinutes || ''}
                  onChange={(e) => handlePollingChange('stuckThresholdMinutes', e.target.value)}
                  disabled={loading || saving || isPassive}
                />
                <p className="text-sm text-text-secondary">
                  How long a ticket must be idle before considered stuck.
                </p>
              </div>

              <div className="space-y-1">
                <label className="text-sm font-medium text-text-primary" htmlFor="alert-cooldown">
                  Alert Cooldown (minutes)
                </label>
                <Input
                  id="alert-cooldown"
                  type="number"
                  min={1}
                  value={polling.alertCooldownMinutes || ''}
                  onChange={(e) => handlePollingChange('alertCooldownMinutes', e.target.value)}
                  disabled={loading || saving || isPassive}
                />
                <p className="text-sm text-text-secondary">
                  Minimum quiet period between repeated alerts of the same type.
                </p>
              </div>
            </div>
          </SettingsSection>

          <div className="flex items-center gap-3 pt-4">
            <Button onClick={save} disabled={loading || saving || !hasChanges}>
              {saving ? 'Saving...' : 'Save Board Settings'}
            </Button>
            <Button
              variant="outline"
              onClick={resetToDefaults}
              disabled={loading || saving}
            >
              <RotateCcw className="h-4 w-4 mr-2" />
              Reset to Defaults
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
