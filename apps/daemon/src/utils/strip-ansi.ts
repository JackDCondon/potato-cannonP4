/**
 * Strip ANSI escape sequences and carriage returns from PTY output.
 * Handles cursor positioning, colors, screen clearing, and other terminal escapes.
 */
export function stripAnsi(input: string): string {
  return input
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .replace(/\r/g, "");
}
