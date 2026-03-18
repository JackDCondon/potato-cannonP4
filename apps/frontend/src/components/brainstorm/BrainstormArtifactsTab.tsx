import { useState } from 'react'
import { Loader2, FileText } from 'lucide-react'
import { useBrainstormArtifacts } from '@/hooks/queries'
import { renderMarkdown } from '@/lib/markdown'
import { ScrollArea } from '@/components/ui/scroll-area'
import { timeAgo } from '@/lib/utils'

interface BrainstormArtifactsTabProps {
  projectId: string
  brainstormId: string
}

export function BrainstormArtifactsTab({ projectId, brainstormId }: BrainstormArtifactsTabProps) {
  const { data, isLoading } = useBrainstormArtifacts(projectId, brainstormId)
  const [expandedFile, setExpandedFile] = useState<string | null>(null)

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-text-muted" />
      </div>
    )
  }

  const artifacts = data?.artifacts ?? []

  if (artifacts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
        <FileText className="h-8 w-8 text-text-muted mb-3" />
        <p className="text-sm text-text-muted">
          No artifacts yet. The brainstorm agent will create a plan document when tickets are finalized.
        </p>
      </div>
    )
  }

  return (
    <ScrollArea className="h-full">
      <div className="p-4 space-y-3">
        {artifacts.map((artifact) => {
          const isExpanded = expandedFile === artifact.filename || artifacts.length === 1
          return (
            <div key={artifact.filename} className="rounded-lg border border-border bg-bg-tertiary overflow-hidden">
              <button
                onClick={() => setExpandedFile(isExpanded ? null : artifact.filename)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-white/5 transition-colors"
              >
                <FileText className="h-4 w-4 text-indigo-400 shrink-0" />
                <span className="text-sm font-medium text-text-primary flex-1">{artifact.filename}</span>
                <span className="text-xs text-text-muted">{timeAgo(artifact.updatedAt)}</span>
              </button>
              {isExpanded && (
                <div className="px-4 pb-4 border-t border-border">
                  <div
                    className="prose prose-sm prose-invert max-w-none text-text-secondary mt-3
                      [&_p]:my-2 [&_ul]:my-2 [&_ol]:my-2 [&_li]:my-0
                      [&_a]:text-accent [&_a]:no-underline hover:[&_a]:underline
                      [&_code]:bg-bg-tertiary [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded
                      [&_pre]:bg-bg-secondary [&_pre]:p-2 [&_pre]:rounded
                      [&_table]:w-full [&_th]:text-left [&_th]:pb-1 [&_td]:py-1"
                    dangerouslySetInnerHTML={{ __html: renderMarkdown(artifact.content) }}
                  />
                </div>
              )}
            </div>
          )
        })}
      </div>
    </ScrollArea>
  )
}
