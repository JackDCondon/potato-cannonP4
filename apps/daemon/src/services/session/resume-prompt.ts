const RESUME_REMINDER = `IMPORTANT: The user can ONLY see messages sent via chat_notify and chat_ask MCP tools. Any text you output directly will NOT be visible to them. Before calling chat_ask, send your reasoning/explanation via chat_notify so the user can see it.`;

/**
 * Build the prompt for a resumed suspended session.
 * Prepends a reminder to use MCP tools for all user-visible output.
 */
export function buildResumePrompt(userResponse: string): string {
  return `${RESUME_REMINDER}\n\nUser response: ${userResponse}`;
}
