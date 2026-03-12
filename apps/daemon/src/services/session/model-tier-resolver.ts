import type { Complexity } from "@potato-cannon/shared";
import type { ModelTier, ModelTierMap } from "../../types/template.types.js";

export function resolveModelTier(
  modelTier: ModelTier | ModelTierMap | undefined,
  complexity?: Complexity | null,
): ModelTier | null {
  if (!modelTier) return null;
  if (typeof modelTier === "string") return modelTier;

  const level = complexity ?? "standard";
  return modelTier[level] ?? modelTier.standard ?? null;
}
