import type { Complexity } from "@potato-cannon/shared";
import type { GlobalConfig, AiProviderConfig } from "../../types/config.types.js";
import type { ModelTier, ModelTierMap } from "../../types/template.types.js";

const LEGACY_MODEL_VALUES = new Set(["haiku", "sonnet", "opus"]);
const MODEL_TIERS = new Set<ModelTier>(["low", "mid", "high"]);

function mapLegacyModelToTier(value: string): ModelTier | null {
  if (value === "haiku") return "low";
  if (value === "sonnet") return "mid";
  if (value === "opus") return "high";
  return null;
}

function assertTierValue(tier: unknown, context: string): asserts tier is ModelTier {
  if (typeof tier !== "string") {
    throw new Error(`${context} must be a string model tier.`);
  }
  if (!MODEL_TIERS.has(tier as ModelTier)) {
    throw new Error(`Invalid model tier "${tier}"; expected one of low, mid, high.`);
  }
}

export function resolveModelTier(
  modelTier: ModelTier | ModelTierMap | undefined,
  complexity?: Complexity | null,
): ModelTier | null {
  if (!modelTier) return null;
  if (typeof modelTier === "string") {
    if (LEGACY_MODEL_VALUES.has(modelTier)) {
      return mapLegacyModelToTier(modelTier) as ModelTier;
    }
    assertTierValue(modelTier, "modelTier");
    return modelTier;
  }

  const level = complexity ?? "standard";
  const selectedTier = modelTier[level] ?? modelTier.standard;
  if (selectedTier === undefined) return null;
  if (LEGACY_MODEL_VALUES.has(selectedTier)) {
    return mapLegacyModelToTier(selectedTier) as ModelTier;
  }
  assertTierValue(selectedTier, `modelTier.${level}`);
  return selectedTier;
}

export function resolveEffectiveProvider(
  project: { providerOverride?: string },
  config: GlobalConfig,
): AiProviderConfig {
  const providers = config.ai?.providers ?? [];
  const providerId = project.providerOverride || config.ai?.defaultProvider;
  if (!providerId) {
    throw new Error("No AI provider configured. Set ai.defaultProvider in global config.");
  }

  const provider = providers.find((entry) => entry.id === providerId);
  if (!provider) {
    throw new Error(`AI provider "${providerId}" is not configured.`);
  }
  return provider;
}

export function resolveConcreteModelForWorker(input: {
  modelTier: ModelTier | ModelTierMap | undefined;
  complexity?: Complexity | null;
  project: { providerOverride?: string };
  config: GlobalConfig;
}): { providerId: string; tier: ModelTier; model: string } | null {
  const tier = resolveModelTier(input.modelTier, input.complexity);
  if (!tier) return null;

  const provider = resolveEffectiveProvider(input.project, input.config);
  const model = provider.models[tier];
  if (!model) {
    throw new Error(`Provider "${provider.id}" is missing model mapping for tier "${tier}".`);
  }

  return {
    providerId: provider.id,
    tier,
    model,
  };
}
