import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { toast } from 'sonner'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { SettingsSection } from '@/components/configure/SettingsSection'
import { api } from '@/api/client'

function GlobalConfigurePage() {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [mcpServerPath, setMcpServerPath] = useState('')
  const [savedPath, setSavedPath] = useState('')

  useEffect(() => {
    let cancelled = false

    api.getGlobalConfig()
      .then((config) => {
        if (cancelled) return
        const nextPath = config.perforce.mcpServerPath || ''
        setMcpServerPath(nextPath)
        setSavedPath(nextPath)
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : 'Failed to load global settings'
        toast.error(message)
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })

    return () => {
      cancelled = true
    }
  }, [])

  const save = async () => {
    const normalized = mcpServerPath.trim()
    setSaving(true)
    try {
      await api.updatePerforceGlobalConfig(normalized)
      setSavedPath(normalized)
      toast.success('Global settings saved')
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to save global settings'
      toast.error(message)
    } finally {
      setSaving(false)
    }
  }

  const hasChanges = mcpServerPath.trim() !== savedPath

  return (
    <div className="@container h-full overflow-y-auto">
      <div className="max-w-5xl mx-auto p-6 pb-12">
        <div className="space-y-2">
          <SettingsSection
            title="Global Settings"
            description="Daemon-wide configuration shared across all projects."
          >
            <div className="space-y-4 max-w-xl">
              <div className="space-y-1">
                <label className="text-sm font-medium text-text-primary">Perforce MCP Server Path</label>
                <Input
                  value={mcpServerPath}
                  onChange={(e) => setMcpServerPath(e.target.value)}
                  placeholder="C:\\tools\\perforce-p4-mcp\\dist\\index.js"
                  disabled={loading || saving}
                />
                <p className="text-sm text-text-secondary">
                  Optional absolute path to the Perforce MCP entrypoint. Leave empty to use package auto-discovery.
                </p>
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
