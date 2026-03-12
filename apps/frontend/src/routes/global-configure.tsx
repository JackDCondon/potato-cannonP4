import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { SettingsSection } from '@/components/configure/SettingsSection'
import { api, type GlobalConfigResponse } from '@/api/client'

export function GlobalConfigurePage() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const [mcpServerPath, setMcpServerPath] = useState('')
  const [savedPath, setSavedPath] = useState('')

  const [defaultProvider, setDefaultProvider] = useState('')
  const [providers, setProviders] = useState<GlobalConfigResponse['ai']['providers']>([])
  const [savedAiKey, setSavedAiKey] = useState('')

  useEffect(() => {
    let cancelled = false

    api.getGlobalConfig()
      .then((config) => {
        if (cancelled) return
        const nextPath = config.perforce.mcpServerPath || ''
        setMcpServerPath(nextPath)
        setSavedPath(nextPath)

        setDefaultProvider(config.ai.defaultProvider)
        setProviders(config.ai.providers)
        setSavedAiKey(JSON.stringify(config.ai))
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : 'Failed to load global settings'
        toast.error(message)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  const nextAiConfig = useMemo(() => ({
    defaultProvider,
    providers,
  }), [defaultProvider, providers])

  const hasPerforceChanges = mcpServerPath.trim() !== savedPath
  const hasAiChanges = JSON.stringify(nextAiConfig) !== savedAiKey
  const hasChanges = hasPerforceChanges || hasAiChanges

  const updateProvider = (
    index: number,
    update: {
      id?: string
      models?: Partial<GlobalConfigResponse['ai']['providers'][number]['models']>
    },
  ) => {
    setProviders((current) => current.map((provider, providerIndex) => {
      if (providerIndex !== index) return provider
      return {
        ...provider,
        ...update,
        models: {
          ...provider.models,
          ...update.models,
        },
      }
    }))
  }

  const save = async () => {
    const normalizedPath = mcpServerPath.trim()
    setSaving(true)
    try {
      if (hasPerforceChanges) {
        await api.updatePerforceGlobalConfig(normalizedPath)
        setSavedPath(normalizedPath)
      }

      if (hasAiChanges) {
        await api.updateAiGlobalConfig(nextAiConfig)
        setSavedAiKey(JSON.stringify(nextAiConfig))
      }

      toast.success('Global settings saved')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save global settings'
      toast.error(message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="@container h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto p-6 pb-12">
        <div className="space-y-2">
          <SettingsSection
            title="Global Settings"
            description="Daemon-wide configuration shared across all projects."
          >
            <div className="space-y-6 max-w-3xl">
              <div className="space-y-1">
                <label className="text-sm font-medium text-text-primary" htmlFor="mcp-server-path">
                  Perforce MCP Server Path
                </label>
                <Input
                  id="mcp-server-path"
                  value={mcpServerPath}
                  onChange={(e) => setMcpServerPath(e.target.value)}
                  placeholder="C:\\tools\\perforce-p4-mcp\\dist\\index.js"
                  disabled={loading || saving}
                />
                <p className="text-sm text-text-secondary">
                  Optional absolute path to the Perforce MCP entrypoint. Leave empty to use package auto-discovery.
                </p>
              </div>

              <div className="space-y-4">
                <h3 className="text-sm font-medium text-text-primary">AI Provider Routing</h3>

                <div className="space-y-1">
                  <label className="text-sm font-medium text-text-primary" htmlFor="default-provider">
                    Default Provider
                  </label>
                  <select
                    id="default-provider"
                    value={defaultProvider}
                    onChange={(e) => setDefaultProvider(e.target.value)}
                    disabled={loading || saving}
                    className="border-border/50 bg-bg-tertiary/50 h-9 w-full rounded-md border px-3 text-sm"
                  >
                    {providers.map((provider) => (
                      <option key={provider.id} value={provider.id}>{provider.id}</option>
                    ))}
                  </select>
                </div>

                <div className="space-y-3">
                  {providers.map((provider, index) => (
                    <div key={`${provider.id}-${index}`} className="border border-border/50 rounded-md p-3 space-y-2">
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-text-secondary" htmlFor={`provider-id-${index}`}>
                          Provider ID
                        </label>
                        <Input
                          id={`provider-id-${index}`}
                          value={provider.id}
                          onChange={(e) => updateProvider(index, { id: e.target.value })}
                          disabled={loading || saving}
                        />
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-text-secondary" htmlFor={`provider-low-${index}`}>
                            low
                          </label>
                          <Input
                            id={`provider-low-${index}`}
                            value={provider.models.low}
                            onChange={(e) => updateProvider(index, { models: { low: e.target.value } })}
                            disabled={loading || saving}
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-text-secondary" htmlFor={`provider-mid-${index}`}>
                            mid
                          </label>
                          <Input
                            id={`provider-mid-${index}`}
                            value={provider.models.mid}
                            onChange={(e) => updateProvider(index, { models: { mid: e.target.value } })}
                            disabled={loading || saving}
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-text-secondary" htmlFor={`provider-high-${index}`}>
                            high
                          </label>
                          <Input
                            id={`provider-high-${index}`}
                            value={provider.models.high}
                            onChange={(e) => updateProvider(index, { models: { high: e.target.value } })}
                            disabled={loading || saving}
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <Button onClick={save} disabled={loading || saving || !hasChanges}>
                  {saving ? 'Saving...' : 'Save Global Settings'}
                </Button>
              </div>
            </div>
          </SettingsSection>
        </div>
      </div>
    </div>
  )
}

export const Route = createFileRoute('/global-configure')({
  component: GlobalConfigurePage,
})
