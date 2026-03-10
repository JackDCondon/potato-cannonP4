import { useMemo, useState } from "react"
import { X } from "lucide-react"
import { toast } from "sonner"
import type { DependencyTier } from "@potato-cannon/shared"
import { useAddDependency, useRemoveDependency, useTicketDependencies, useTickets } from "@/hooks/queries"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { IconButton } from "@/components/ui/icon-button"

interface DependenciesSectionProps {
  projectId: string
  ticketId: string
  workflowId?: string
}

export function DependenciesSection({ projectId, ticketId, workflowId }: DependenciesSectionProps) {
  const [query, setQuery] = useState("")
  const [selectedDependsOn, setSelectedDependsOn] = useState<string>("")
  const [tier, setTier] = useState<DependencyTier>("artifact-ready")

  const { data: dependencies } = useTicketDependencies(projectId, ticketId)
  const { data: tickets } = useTickets(projectId, workflowId ?? null)
  const addDependency = useAddDependency()
  const removeDependency = useRemoveDependency()

  const existingDependencyIds = useMemo(
    () => new Set((dependencies ?? []).map((dep) => dep.ticketId)),
    [dependencies],
  )

  const candidates = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    return (tickets ?? []).filter((candidate) => {
      if (candidate.id === ticketId) return false
      if (existingDependencyIds.has(candidate.id)) return false
      if (!normalizedQuery) return true
      return (
        candidate.id.toLowerCase().includes(normalizedQuery) ||
        candidate.title.toLowerCase().includes(normalizedQuery)
      )
    })
  }, [tickets, ticketId, existingDependencyIds, query])

  const selectedTicket = useMemo(
    () => (tickets ?? []).find((ticket) => ticket.id === selectedDependsOn),
    [tickets, selectedDependsOn],
  )

  const handleAddDependency = () => {
    if (!selectedDependsOn) return
    addDependency.mutate(
      {
        projectId,
        ticketId,
        dependsOn: selectedDependsOn,
        tier,
      },
      {
        onSuccess: () => {
          toast.success("Dependency added")
          setQuery("")
          setSelectedDependsOn("")
          setTier("artifact-ready")
        },
        onError: (error) => {
          toast.error("Failed to add dependency", {
            description: (error as Error).message,
          })
        },
      },
    )
  }

  const handleRemoveDependency = (dependsOn: string) => {
    removeDependency.mutate(
      {
        projectId,
        ticketId,
        dependsOn,
      },
      {
        onSuccess: () => {
          toast.success("Dependency removed")
        },
        onError: (error) => {
          toast.error("Failed to remove dependency", {
            description: (error as Error).message,
          })
        },
      },
    )
  }

  return (
    <div className="space-y-3">
      <h3 className="text-xs font-medium text-text-muted uppercase tracking-wide">Dependencies</h3>

      <div className="rounded-lg bg-bg-tertiary border border-border p-3 space-y-2">
        {(dependencies ?? []).length === 0 ? (
          <p className="text-sm text-text-muted italic">No dependencies</p>
        ) : (
          <div className="space-y-2">
            {(dependencies ?? []).map((dep) => (
              <div key={`${dep.ticketId}-${dep.tier}`} className="flex items-center gap-2 rounded bg-bg-secondary px-2 py-2">
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-text-primary truncate">{dep.title}</div>
                  <div className="text-xs text-text-muted">{dep.ticketId}</div>
                </div>
                <Badge variant="outline" className="text-xs">{dep.currentPhase}</Badge>
                <Badge variant="outline" className="text-xs">{dep.tier}</Badge>
                <Badge
                  variant="outline"
                  className={dep.satisfied ? "text-green-400 border-green-500/50" : "text-red-400 border-red-500/50"}
                >
                  {dep.satisfied ? "Satisfied" : "Blocked"}
                </Badge>
                <IconButton tooltip="Remove dependency" onClick={() => handleRemoveDependency(dep.ticketId)}>
                  <X className="h-3 w-3" />
                </IconButton>
              </div>
            ))}
          </div>
        )}

        <div className="rounded border border-border bg-bg-secondary p-2 space-y-2">
          <div className="space-y-1">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search tickets by id or title..."
            />
            {candidates.length > 0 && (
              <div className="max-h-32 overflow-y-auto rounded border border-border bg-bg-tertiary">
                {candidates.slice(0, 10).map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    onClick={() => {
                      setSelectedDependsOn(candidate.id)
                      setQuery(candidate.title)
                    }}
                    className="w-full text-left px-2 py-1.5 hover:bg-bg-hover text-sm"
                  >
                    <span className="text-text-primary">{candidate.title}</span>
                    <span className="text-text-muted"> ({candidate.id})</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            <div className="flex-1 text-xs text-text-muted truncate">
              {selectedTicket ? `Selected: ${selectedTicket.title} (${selectedTicket.id})` : "Select a dependency ticket"}
            </div>
            <Select value={tier} onValueChange={(value) => setTier(value as DependencyTier)}>
              <SelectTrigger className="w-[160px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="artifact-ready">artifact-ready</SelectItem>
                <SelectItem value="code-ready">code-ready</SelectItem>
              </SelectContent>
            </Select>
            <Button
              size="sm"
              onClick={handleAddDependency}
              disabled={!selectedDependsOn || addDependency.isPending}
            >
              Add
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
