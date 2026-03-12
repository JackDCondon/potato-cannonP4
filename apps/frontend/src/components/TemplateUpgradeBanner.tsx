// src/components/TemplateUpgradeBanner.tsx
import { useState } from "react";
import { useTemplateStatus, useUpgradeTemplate } from "@/hooks/useTemplateStatus";
import { ChangelogModal } from "./ChangelogModal";

interface Props {
  projectId: string;
  workflowId?: string | null;
}

export function TemplateUpgradeBanner({ projectId, workflowId }: Props) {
  const { data: status, isLoading } = useTemplateStatus(projectId, workflowId ?? undefined);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [showChangelog, setShowChangelog] = useState(false);
  const upgradeMutation = useUpgradeTemplate();

  if (isLoading || !status?.upgradeType) {
    return null;
  }

  // Patch upgrades are auto, shouldn't show banner
  if (status.upgradeType === "patch") {
    return null;
  }

  const isMajor = status.upgradeType === "major";

  const handleUpgrade = () => {
    if (isMajor) {
      setShowConfirmModal(true);
    } else {
      if (!workflowId) return;
      upgradeMutation.mutate({ projectId, workflowId, force: false });
    }
  };

  if (!workflowId) {
    return null;
  }

  return (
    <>
      <div
        className={`px-4 py-2 text-sm flex items-center justify-between ${
          isMajor
            ? "bg-amber-900/50 text-amber-200"
            : "bg-blue-900/50 text-blue-200"
        }`}
      >
        <span>
          {isMajor ? "Breaking template update" : "Template update available"}
          {" "}({status.current} → {status.available})
        </span>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowChangelog(true)}
            className={`px-3 py-1 rounded text-sm font-medium ${
              isMajor
                ? "text-amber-300 hover:text-amber-100 hover:bg-amber-800/50"
                : "text-blue-300 hover:text-blue-100 hover:bg-blue-800/50"
            }`}
          >
            View Changes
          </button>
          <button
            onClick={handleUpgrade}
            disabled={upgradeMutation.isPending}
            className={`px-3 py-1 rounded text-sm font-medium ${
              isMajor
                ? "bg-amber-600 hover:bg-amber-500 text-white"
                : "bg-blue-600 hover:bg-blue-500 text-white"
            } disabled:opacity-50`}
          >
            {upgradeMutation.isPending ? "Upgrading..." : "Upgrade"}
          </button>
        </div>
      </div>

      {showChangelog && (
        <ChangelogModal
          projectId={projectId}
          workflowId={workflowId}
          onClose={() => setShowChangelog(false)}
        />
      )}

      {showConfirmModal && (
        <MajorUpgradeModal
          projectId={projectId}
          currentVersion={status.current!}
          newVersion={status.available!}
          onConfirm={() => {
            upgradeMutation.mutate(
              { projectId, workflowId, force: true },
              {
                onSuccess: () => setShowConfirmModal(false),
              }
            );
          }}
          onCancel={() => setShowConfirmModal(false)}
          isPending={upgradeMutation.isPending}
        />
      )}
    </>
  );
}

interface ModalProps {
  projectId: string;
  currentVersion: string;
  newVersion: string;
  onConfirm: () => void;
  onCancel: () => void;
  isPending: boolean;
}

function MajorUpgradeModal({
  currentVersion,
  newVersion,
  onConfirm,
  onCancel,
  isPending,
}: ModalProps) {
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
      <div className="bg-gray-800 rounded-lg p-6 max-w-md w-full mx-4 border border-gray-700">
        <h2 className="text-xl font-bold text-white mb-4">
          Breaking Template Update
        </h2>
        <p className="text-gray-300 mb-4">
          Upgrading from <span className="font-mono text-amber-400">{currentVersion}</span> to{" "}
          <span className="font-mono text-amber-400">{newVersion}</span> is a major version change.
        </p>
        <div className="bg-red-900/30 border border-red-700 rounded p-3 mb-4">
          <p className="text-red-300 text-sm">
            <strong>Warning:</strong> All in-progress tickets will be moved back to Ideas phase.
            All progress including artifacts, tasks, comments, worktrees, and branches will be deleted.
          </p>
        </div>
        <div className="flex gap-3 justify-end">
          <button
            onClick={onCancel}
            disabled={isPending}
            className="px-4 py-2 text-gray-300 hover:text-white"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={isPending}
            className="px-4 py-2 bg-red-600 hover:bg-red-500 text-white rounded font-medium disabled:opacity-50"
          >
            {isPending ? "Upgrading..." : "I understand, upgrade anyway"}
          </button>
        </div>
      </div>
    </div>
  );
}
