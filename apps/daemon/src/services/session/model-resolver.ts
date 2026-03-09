import type { ModelSpec } from "../../types/template.types.js";
import { isComplexityModelMap } from "../../types/template.types.js";
import type { Complexity } from "@potato-cannon/shared";

/**
 * Known model shortcuts that map to themselves (Claude CLI handles resolution)
 */
const MODEL_SHORTCUTS = ["haiku", "sonnet", "opus"] as const;

/**
 * Resolve a model specification to a CLI-ready string.
 *
 * Handles three ModelSpec forms:
 *   1. String — shortcut ("haiku") or explicit Claude ID ("claude-sonnet-4-...")
 *   2. Object — { id, provider? } explicit model object
 *   3. ComplexityModelMap — { simple?, standard?, complex? } — selects the entry
 *      matching `complexity`, falling back to `standard` when the param is null/
 *      undefined or the matching key is absent.
 *
 * Returns null when the spec is absent or unrecognisable (caller uses CLI default).
 *
 * @param model      - The model specification from the workflow config, or undefined.
 * @param complexity - The ticket/task complexity level used to select from a map.
 * @returns CLI-ready model string, or null to use the Claude Code default.
 */
export function resolveModel(
  model: ModelSpec | undefined,
  complexity?: Complexity | null
): string | null {
  if (!model) return null;

  // ComplexityModelMap: { simple?, standard?, complex? }
  if (isComplexityModelMap(model)) {
    const level = complexity ?? "standard";
    // Fall back to standard when the requested level is absent from the map.
    const entry = model[level] ?? model.standard;
    if (!entry) return null;
    // Recurse with null complexity so the string branch handles the chosen entry.
    return resolveModel(entry, null);
  }

  // String format: shortcut or explicit ID
  if (typeof model === "string") {
    // Empty string is invalid
    if (model === "") {
      return null;
    }

    // Shortcuts are passed directly to Claude CLI (it handles resolution)
    if (MODEL_SHORTCUTS.includes(model as (typeof MODEL_SHORTCUTS)[number])) {
      return model;
    }

    // Explicit model IDs (e.g., "claude-sonnet-4-20250514")
    if (model.startsWith("claude-")) {
      return model;
    }

    // Unrecognized model
    console.warn(`[resolveModel] Unrecognized model "${model}", using default`);
    return null;
  }

  // Object format: { id, provider? }
  if (typeof model === "object" && model.id) {
    // Empty id is invalid
    if (model.id === "") {
      return null;
    }

    // For now, only support Anthropic provider (or no provider specified)
    if (model.provider && model.provider !== "anthropic") {
      console.warn(
        `[resolveModel] Provider "${model.provider}" not supported, using default`
      );
      return null;
    }

    return model.id;
  }

  return null;
}
