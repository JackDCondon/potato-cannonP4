import { useCallback, useEffect, useMemo, useState } from 'react'
import { Check, RotateCcw } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { api } from '@/api/client'
import { getEpicIcon, getEpicColor } from '@/lib/epic-icons'
import { EPIC_BADGE_COLORS, EPIC_BADGE_ICONS } from '@potato-cannon/shared'
import { SettingsSection } from '@/components/configure/SettingsSection'
import { PmModeSelector } from '@/components/configure/PmModeSelector'
import { PmAlertToggles } from '@/components/configure/PmAlertToggles'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { Brainstorm } from '@potato-cannon/shared'
import type { PmConfig, PmMode, PmAlertConfig, PmPollingConfig } from '@potato-cannon/shared'
import { DEFAULT_PM_CONFIG } from '@potato-cannon/shared'

// ---------- Props ----------

interface EpicSettingsTabProps {
  projectId: string
  brainstorm: Brainstorm
  onBrainstormUpdated: () => void
}

// ---------- Color Section ----------

interface ColorGridProps {
  selectedColor: string | null | undefined
  onSelect: (color: string) => void
  disabled: boolean
}

function ColorGrid({ selectedColor, onSelect, disabled }: ColorGridProps) {
  return (
    <div className="flex flex-wrap gap-2">
      {EPIC_BADGE_COLORS.map((color) => {
        const isSelected = color === selectedColor
        return (
          <button
            key={color}
            type="button"
            disabled={disabled}
            onClick={() => onSelect(color)}
            title={color}
            className={cn(
              'relative flex h-8 w-8 items-center justify-center rounded-full transition-all',
              'ring-offset-bg-primary focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              isSelected && 'ring-2 ring-accent ring-offset-2',
            )}
            style={{ backgroundColor: color }}
          >
            {isSelected && (
              <Check
                className="h-4 w-4"
                style={{ color: '#fff', filter: 'drop-shadow(0 1px 1px rgba(0,0,0,0.25))' }}
              />
            )}
          </button>
        )
      })}
    </div>
  )
}

// ---------- Icon Section ----------

interface IconGridProps {
  selectedIcon: string | null | undefined
  epicColor: string
  onSelect: (icon: string) => void
  disabled: boolean
}

function IconGrid({ selectedIcon, epicColor, onSelect, disabled }: IconGridProps) {
  return (
    <div className="@container">
      <div className="grid grid-cols-5 gap-1 @xs:grid-cols-7 @sm:grid-cols-8 @md:grid-cols-9 @lg:grid-cols-10">
        {EPIC_BADGE_ICONS.map((iconName) => {
          const Icon = getEpicIcon(iconName)
          const isSelected = iconName === selectedIcon
          return (
            <button
              key={iconName}
              type="button"
              disabled={disabled}
              onClick={() => onSelect(iconName)}
              title={iconName}
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-md transition-colors',
                'hover:bg-bg-tertiary hover:text-text-primary',
                'disabled:opacity-50 disabled:cursor-not-allowed',
                isSelected ? 'bg-bg-tertiary' : 'text-text-secondary',
              )}
              style={isSelected ? { color: epicColor } : undefined}
            >
              <Icon className="h-4 w-4" />
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ---------- Main Component ----------

export function EpicSettingsTab({ projectId, brainstorm, onBrainstormUpdated }: EpicSettingsTabProps) {
  // ---- Epic appearance state ----
  const [savingAppearance, setSavingAppearance] = useState(false)

  const effectiveColor = getEpicColor(brainstorm.color)

  const handleColorSelect = useCallback(async (color: string) => {
    if (color === brainstorm.color) return
    setSavingAppearance(true)
    try {
      await api.updateBrainstorm(projectId, brainstorm.id, { color })
      onBrainstormUpdated()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update epic color'
      toast.error(message)
    } finally {
      setSavingAppearance(false)
    }
  }, [projectId, brainstorm.id, brainstorm.color, onBrainstormUpdated])

  const handleIconSelect = useCallback(async (icon: string) => {
    if (icon === brainstorm.icon) return
    setSavingAppearance(true)
    try {
      await api.updateBrainstorm(projectId, brainstorm.id, { icon })
      onBrainstormUpdated()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to update epic icon'
      toast.error(message)
    } finally {
      setSavingAppearance(false)
    }
  }, [projectId, brainstorm.id, brainstorm.icon, onBrainstormUpdated])

  // ---- PM config state ----
  const workflowId = brainstorm.workflowId
  const hasPmConfig = !!workflowId

  const [loadingPm, setLoadingPm] = useState(hasPmConfig)
  const [savingPm, setSavingPm] = useState(false)
  const [mode, setMode] = useState<PmMode>(DEFAULT_PM_CONFIG.mode)
  const [polling, setPolling] = useState<PmPollingConfig>({ ...DEFAULT_PM_CONFIG.polling })
  const [alerts, setAlerts] = useState<PmAlertConfig>({ ...DEFAULT_PM_CONFIG.alerts })
  const [savedSnapshot, setSavedSnapshot] = useState('')

  const currentPmConfig = useMemo<PmConfig>(() => ({ mode, polling, alerts }), [mode, polling, alerts])
  const currentSnapshot = useMemo(() => JSON.stringify(currentPmConfig), [currentPmConfig])
  const hasPmChanges = currentSnapshot !== savedSnapshot

  const applyPmConfig = useCallback((config: PmConfig) => {
    setMode(config.mode)
    setPolling({ ...config.polling })
    setAlerts({ ...config.alerts })
  }, [])

  useEffect(() => {
    if (!hasPmConfig || !workflowId) {
      setLoadingPm(false)
      return
    }

    let cancelled = false
    setLoadingPm(true)

    api.getBoardSettings(projectId, workflowId)
      .then(({ pmConfig }) => {
        if (cancelled) return
        applyPmConfig(pmConfig)
        setSavedSnapshot(JSON.stringify(pmConfig))
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : 'Failed to load PM settings'
        toast.error(message)
      })
      .finally(() => {
        if (!cancelled) setLoadingPm(false)
      })

    return () => { cancelled = true }
  }, [projectId, workflowId, hasPmConfig, applyPmConfig])

  const handlePollingChange = useCallback(
    (field: keyof PmPollingConfig, raw: string) => {
      const parsed = parseInt(raw, 10)
      if (!Number.isNaN(parsed) && parsed >= 1) {
        setPolling((prev) => ({ ...prev, [field]: parsed }))
      } else if (raw === '') {
        setPolling((prev) => ({ ...prev, [field]: 0 }))
      }
    },
    [],
  )

  const savePmConfig = useCallback(async () => {
    if (!workflowId) return
    if (polling.intervalMinutes < 1 || polling.stuckThresholdMinutes < 1 || polling.alertCooldownMinutes < 1) {
      toast.error('Polling values must be at least 1 minute')
      return
    }
    setSavingPm(true)
    try {
      const { pmConfig } = await api.updateBoardPmSettings(projectId, workflowId, currentPmConfig)
      applyPmConfig(pmConfig)
      setSavedSnapshot(JSON.stringify(pmConfig))
      toast.success('PM settings saved')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save PM settings'
      toast.error(message)
    } finally {
      setSavingPm(false)
    }
  }, [projectId, workflowId, currentPmConfig, applyPmConfig, polling])

  const resetPmConfig = useCallback(async () => {
    if (!workflowId) return
    setSavingPm(true)
    try {
      const { pmConfig } = await api.resetBoardPmSettings(projectId, workflowId)
      applyPmConfig(pmConfig)
      setSavedSnapshot(JSON.stringify(pmConfig))
      toast.success('PM settings reset to defaults')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to reset PM settings'
      toast.error(message)
    } finally {
      setSavingPm(false)
    }
  }, [projectId, workflowId, applyPmConfig])

  const isPassive = mode === 'passive'
  const pmDisabled = loadingPm || savingPm

  return (
    <div className="@container h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto p-6 pb-12">
        <div className="space-y-2">

          {/* Color */}
          <SettingsSection
            title="Epic Color"
            description="Choose a color to visually identify this epic on the board."
          >
            <ColorGrid
              selectedColor={brainstorm.color}
              onSelect={handleColorSelect}
              disabled={savingAppearance}
            />
          </SettingsSection>

          {/* Icon */}
          <SettingsSection
            title="Epic Icon"
            description="Choose an icon shown in epic badges, highlighted in the epic's color."
          >
            <IconGrid
              selectedIcon={brainstorm.icon}
              epicColor={effectiveColor}
              onSelect={handleIconSelect}
              disabled={savingAppearance}
            />
          </SettingsSection>

          {/* PM Config — only rendered when this epic has an associated workflow */}
          {hasPmConfig && (
            <>
              <SettingsSection
                title="PM Mode"
                description="Choose how the Project Manager operates on this epic's board."
              >
                <PmModeSelector value={mode} onChange={setMode} disabled={pmDisabled} />
              </SettingsSection>

              <SettingsSection
                title="Alert Categories"
                description="Enable or disable specific alert types. Greyed out in passive mode."
              >
                <PmAlertToggles
                  value={alerts}
                  onChange={setAlerts}
                  disabled={pmDisabled || isPassive}
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
                    <label className="text-sm font-medium text-text-primary" htmlFor="epic-poll-interval">
                      Poll Interval (minutes)
                    </label>
                    <Input
                      id="epic-poll-interval"
                      type="number"
                      min={1}
                      value={polling.intervalMinutes || ''}
                      onChange={(e) => handlePollingChange('intervalMinutes', e.target.value)}
                      disabled={pmDisabled || isPassive}
                    />
                    <p className="text-sm text-text-secondary">How often the poller checks for issues.</p>
                  </div>

                  <div className="space-y-1">
                    <label className="text-sm font-medium text-text-primary" htmlFor="epic-stuck-threshold">
                      Stuck Threshold (minutes)
                    </label>
                    <Input
                      id="epic-stuck-threshold"
                      type="number"
                      min={1}
                      value={polling.stuckThresholdMinutes || ''}
                      onChange={(e) => handlePollingChange('stuckThresholdMinutes', e.target.value)}
                      disabled={pmDisabled || isPassive}
                    />
                    <p className="text-sm text-text-secondary">
                      How long a ticket must be idle before considered stuck.
                    </p>
                  </div>

                  <div className="space-y-1">
                    <label className="text-sm font-medium text-text-primary" htmlFor="epic-alert-cooldown">
                      Alert Cooldown (minutes)
                    </label>
                    <Input
                      id="epic-alert-cooldown"
                      type="number"
                      min={1}
                      value={polling.alertCooldownMinutes || ''}
                      onChange={(e) => handlePollingChange('alertCooldownMinutes', e.target.value)}
                      disabled={pmDisabled || isPassive}
                    />
                    <p className="text-sm text-text-secondary">
                      Minimum quiet period between repeated alerts of the same type.
                    </p>
                  </div>
                </div>
              </SettingsSection>

              <div className="flex items-center gap-3 pt-4">
                <Button onClick={savePmConfig} disabled={pmDisabled || !hasPmChanges}>
                  {savingPm ? 'Saving...' : 'Save PM Settings'}
                </Button>
                <Button variant="outline" onClick={resetPmConfig} disabled={pmDisabled}>
                  <RotateCcw className="h-4 w-4 mr-2" />
                  Reset to Defaults
                </Button>
              </div>
            </>
          )}

        </div>
      </div>
    </div>
  )
}
