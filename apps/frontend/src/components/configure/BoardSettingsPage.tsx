import { useCallback, useEffect, useState } from 'react'
import { Input } from '@/components/ui/input'
import { SettingsSection } from './SettingsSection'
import { PmModeSelector } from './PmModeSelector'
import { PmAlertToggles } from './PmAlertToggles'
import type { PmConfig, PmMode, PmAlertConfig, PmPollingConfig } from '@potato-cannon/shared'
import { loadBoardPmDefaults, saveBoardPmDefaults } from '@/lib/pm-storage'

interface BoardSettingsPageProps {
  projectId: string
  workflowId: string
}

export function BoardSettingsPage({ projectId, workflowId }: BoardSettingsPageProps) {
  const [config, setConfig] = useState<PmConfig>(loadBoardPmDefaults)

  const mode = config.mode
  const polling = config.polling
  const alerts = config.alerts
  const isPassive = mode === 'passive'

  useEffect(() => {
    setConfig(loadBoardPmDefaults())
  }, [projectId, workflowId])

  const updateConfig = useCallback(
    (updater: (previous: PmConfig) => PmConfig, options?: { persist?: boolean }) => {
      setConfig((previous) => {
        const next = updater(previous)
        if (options?.persist !== false) {
          saveBoardPmDefaults(next)
        }
        return next
      })
    },
    [],
  )

  const handleModeChange = useCallback(
    (nextMode: PmMode) => {
      updateConfig((previous) => ({ ...previous, mode: nextMode }))
    },
    [updateConfig],
  )

  const handleAlertsChange = useCallback(
    (nextAlerts: PmAlertConfig) => {
      updateConfig((previous) => ({ ...previous, alerts: nextAlerts }))
    },
    [updateConfig],
  )

  const handlePollingChange = useCallback(
    (field: keyof PmPollingConfig, raw: string) => {
      const parsed = parseInt(raw, 10)
      if (!Number.isNaN(parsed) && parsed >= 1) {
        updateConfig((previous) => ({
          ...previous,
          polling: { ...previous.polling, [field]: parsed },
        }))
      } else if (raw === '') {
        // Allow temporary empty input while typing; persist only valid values.
        updateConfig(
          (previous) => ({
            ...previous,
            polling: { ...previous.polling, [field]: 0 },
          }),
          { persist: false },
        )
      }
    },
    [updateConfig],
  )

  return (
    <div className="@container h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto p-6 pb-12">
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            These defaults are applied when enabling PM on a new epic.
          </p>

          <SettingsSection
            title="PM Mode"
            description="Choose how the Project Manager operates on this board."
          >
            <PmModeSelector
              value={mode}
              onChange={handleModeChange}
            />
          </SettingsSection>

          <SettingsSection
            title="Alert Categories"
            description="Enable or disable specific alert types. Greyed out in passive mode."
          >
            <PmAlertToggles
              value={alerts}
              onChange={handleAlertsChange}
              disabled={isPassive}
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
                />
                <p className="text-sm text-text-secondary">
                  Minimum quiet period between repeated alerts of the same type.
                </p>
              </div>
            </div>
          </SettingsSection>
        </div>
      </div>
    </div>
  )
}
