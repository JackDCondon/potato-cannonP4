/**
 * Translate standard markdown to Slack mrkdwn format.
 *
 * Uses a single-pass regex for bold/italic to avoid a collision where
 * **bold** → *bold* would then be re-matched as *italic* → _italic_.
 * The combined regex matches **double** asterisks first (left-to-right alternation),
 * so double-asterisk content is never re-matched as single-asterisk.
 */
export function toSlackMrkdwn(markdown: string): string {
  let result = markdown;

  // Links: [text](url) → <url|text>  (must run before asterisk transforms)
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // Bold + italic in single pass:
  // Match **bold** (double asterisks) or *italic* (single asterisks) in one regex.
  // The replacer checks which group matched to apply the correct transformation.
  result = result.replace(
    /(\*\*(.+?)\*\*)|(\*(.+?)\*)/g,
    (_match, _boldFull, boldContent, _italicFull, italicContent) => {
      if (boldContent !== undefined) return `*${boldContent}*`;
      if (italicContent !== undefined) return `_${italicContent}_`;
      return _match;
    },
  );

  // Inline code: `code` → `code` (no change needed — same syntax)

  return result;
}
