import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BOARD_NOTIFICATION_PRESET_CATEGORIES,
  DEFAULT_CHAT_NOTIFICATION_POLICY,
  deriveBoardNotificationPreset,
  type BoardNotificationPreset,
  type ChatNotificationCategory,
  type ChatNotificationPolicy,
  type PmAlertConfig,
  type PmConfig,
  type PmMode,
  type PmPollingConfig,
} from '@potato-cannon/shared'
import { api } from '@/api/client'
import { loadBoardPmDefaults, saveBoardPmDefaults } from '@/lib/pm-storage'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { SettingsSection } from './SettingsSection'
import { PmModeSelector } from './PmModeSelector'
import { PmAlertToggles } from './PmAlertToggles'
import { CollapsibleSettingsSection } from './CollapsibleSettingsSection'
import { PhoneNotificationToggles } from './PhoneNotificationToggles'

interface BoardSettingsPageProps {
  projectId: string
  workflowId: string
}

type DisplayPreset = BoardNotificationPreset | 'custom'
type NotificationStatus = 'idle' | 'loading' | 'saving' | 'saved' | 'error'

const PRESET_OPTIONS: Array<{
  value: DisplayPreset
  label: string
  description: string
}> = [
  {
    value: 'all',
    label: 'All notifications',
    description: 'Send every category to connected chat providers.',
  },
  {
    value: 'important_only',
    label: 'Important only',
    description: 'Questions, critical alerts, and PM alerts only.',
  },
  {
    value: 'questions_only',
    label: 'Questions only',
    description: 'Only send questions that still need a reply.',
  },
  {
    value: 'mute_all',
    label: 'Mute all external chat',
    description: 'Keep Potato Cannon unchanged, but stop phone/chat delivery for this board.',
  },
  {
    value: 'custom',
    label: 'Custom',
    description: 'Advanced toggles no longer match a preset.',
  },
]

function SectionBadge({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-full border border-border bg-bg-tertiary px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-text-secondary">
      {children}
    </span>
  )
}

function NotificationStatusText({
  status,
  error,
}: {
  status: NotificationStatus
  error: string | null
}) {
  if (status === 'loading') {
    return <p className="text-xs text-text-secondary">Loading saved board policy...</p>
  }

  if (status === 'saving') {
    return <p className="text-xs text-text-secondary">Saving board policy...</p>
  }

  if (status === 'saved') {
    return <p className="text-xs text-text-secondary">Saved to this board.</p>
  }

  if (status === 'error' && error) {
    return <p className="text-xs text-accent-red">{error}</p>
  }

  return (
    <p className="text-xs text-text-secondary">
      This policy is stored in the backend and applies to every phone/chat provider.
    </p>
  )
}

export function BoardSettingsPage({ projectId, workflowId }: BoardSettingsPageProps) {
  const [config, setConfig] = useState<PmConfig>(loadBoardPmDefaults)
  const [notificationPolicy, setNotificationPolicy] = useState<ChatNotificationPolicy>(
    DEFAULT_CHAT_NOTIFICATION_POLICY,
  )
  const [notificationStatus, setNotificationStatus] = useState<NotificationStatus>('loading')
  const [notificationError, setNotificationError] = useState<string | null>(null)
  const saveSequenceRef = useRef(0)

  const mode = config.mode
  const polling = config.polling
  const alerts = config.alerts
  const isPassive = mode === 'passive'
  const notificationsBusy =
    notificationStatus === 'loading' || notificationStatus === 'saving'

  useEffect(() => {
    setConfig(loadBoardPmDefaults())

    let cancelled = false
    setNotificationStatus('loading')
    setNotificationError(null)

    api
      .getBoardSettings(projectId, workflowId)
      .then((settings) => {
        if (cancelled) return
        setNotificationPolicy(
          settings.chatNotificationPolicy ?? DEFAULT_CHAT_NOTIFICATION_POLICY,
        )
        setNotificationStatus('idle')
      })
      .catch((error) => {
        if (cancelled) return
        setNotificationPolicy(DEFAULT_CHAT_NOTIFICATION_POLICY)
        setNotificationStatus('error')
        setNotificationError(
          error instanceof Error
            ? error.message
            : 'Failed to load board phone notification settings.',
        )
      })

    return () => {
      cancelled = true
    }
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

  const persistNotificationPolicy = useCallback(
    async (nextPolicy: ChatNotificationPolicy, previousPolicy: ChatNotificationPolicy) => {
      const requestId = ++saveSequenceRef.current
      setNotificationPolicy(nextPolicy)
      setNotificationStatus('saving')
      setNotificationError(null)

      try {
        const response = await api.updateBoardNotificationSettings(
          projectId,
          workflowId,
          nextPolicy,
        )
        if (requestId !== saveSequenceRef.current) {
          return
        }
        setNotificationPolicy(response.chatNotificationPolicy)
        setNotificationStatus('saved')
      } catch (error) {
        if (requestId !== saveSequenceRef.current) {
          return
        }
        setNotificationPolicy(previousPolicy)
        setNotificationStatus('error')
        setNotificationError(
          error instanceof Error
            ? error.message
            : 'Failed to save board phone notification settings.',
        )
      }
    },
    [projectId, workflowId],
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

  const selectedPreset = useMemo<DisplayPreset>(() => {
    return deriveBoardNotificationPreset(notificationPolicy.categories) ?? 'custom'
  }, [notificationPolicy.categories])

  const handlePresetChange = useCallback(
    (value: string) => {
      if (value === 'custom') {
        return
      }

      const preset = value as BoardNotificationPreset
      const previousPolicy = notificationPolicy
      const nextPolicy: ChatNotificationPolicy = {
        preset,
        categories: { ...BOARD_NOTIFICATION_PRESET_CATEGORIES[preset] },
      }
      void persistNotificationPolicy(nextPolicy, previousPolicy)
    },
    [notificationPolicy, persistNotificationPolicy],
  )

  const handleNotificationToggle = useCallback(
    (category: ChatNotificationCategory, checked: boolean) => {
      const previousPolicy = notificationPolicy
      const nextCategories = {
        ...notificationPolicy.categories,
        [category]: checked,
      }
      const matchedPreset = deriveBoardNotificationPreset(nextCategories)
      const nextPolicy: ChatNotificationPolicy = {
        preset: matchedPreset ?? notificationPolicy.preset,
        categories: nextCategories,
      }
      void persistNotificationPolicy(nextPolicy, previousPolicy)
    },
    [notificationPolicy, persistNotificationPolicy],
  )

  return (
    <div className="@container h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl p-6 pb-12">
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">
            PM defaults on this page stay local to this browser. Phone notifications are saved to
            the board and enforced by the daemon before anything is sent to external chat providers.
          </p>

          <CollapsibleSettingsSection
            title="Phone Notifications"
            description="Board-wide phone and chat delivery preferences. Potato Cannon still shows every message and question."
            defaultOpen
            badge={<SectionBadge>Saved to board</SectionBadge>}
          >
            <div className="space-y-6 py-2">
              <div className="space-y-2">
                <label className="text-sm font-medium text-text-primary" htmlFor="notification-preset">
                  Delivery preset
                </label>
                <Select value={selectedPreset} onValueChange={handlePresetChange} disabled={notificationsBusy}>
                  <SelectTrigger id="notification-preset" className="w-full max-w-md">
                    <SelectValue placeholder="Choose a preset" />
                  </SelectTrigger>
                  <SelectContent>
                    {PRESET_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value} disabled={option.value === 'custom'}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-sm text-text-secondary">
                  {
                    PRESET_OPTIONS.find((option) => option.value === selectedPreset)?.description
                  }
                </p>
              </div>

              <div className="space-y-3">
                <div className="space-y-1">
                  <h3 className="text-sm font-medium text-text-primary">Advanced controls</h3>
                  <p className="text-sm text-text-secondary">
                    Fine-tune which categories reach your phone. These toggles only affect external
                    chat delivery.
                  </p>
                </div>
                <PhoneNotificationToggles
                  value={notificationPolicy.categories}
                  onChange={handleNotificationToggle}
                  disabled={notificationsBusy}
                />
              </div>

              <NotificationStatusText status={notificationStatus} error={notificationError} />
            </div>
          </CollapsibleSettingsSection>

          <CollapsibleSettingsSection
            title="Project Manager Defaults"
            description="Browser-local defaults applied when enabling PM on a new epic from this machine."
            defaultOpen
            badge={<SectionBadge>Local only</SectionBadge>}
          >
            <div className="space-y-2 py-2">
              <SettingsSection
                title="PM Mode"
                description="Choose how the Project Manager operates on this board."
              >
                <PmModeSelector value={mode} onChange={handleModeChange} />
              </SettingsSection>

              <SettingsSection
                title="Alert Categories"
                description="Enable or disable specific alert types. Greyed out in passive mode."
              >
                <PmAlertToggles value={alerts} onChange={handleAlertsChange} disabled={isPassive} />
                {isPassive && (
                  <p className="mt-3 text-xs text-text-secondary">
                    Alerts are inactive in passive mode. Switch to watching or executing to
                    configure.
                  </p>
                )}
              </SettingsSection>
            </div>
          </CollapsibleSettingsSection>

          <CollapsibleSettingsSection
            title="Advanced"
            description="Browser-local polling defaults used when PM is enabled on a new epic."
            badge={<SectionBadge>Local only</SectionBadge>}
          >
            <div className="py-2">
              <SettingsSection
                title="Polling Configuration"
                description="Timing parameters for the daemon-side polling loop. Only active in watching or executing mode."
              >
                <div className="max-w-md space-y-4">
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
          </CollapsibleSettingsSection>
        </div>
      </div>
    </div>
  )
}
