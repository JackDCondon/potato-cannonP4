import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, afterEach } from 'vitest';
import { EventRow } from './EventRow';
import type { SessionLogEntry } from '@potato-cannon/shared';

afterEach(() => {
  cleanup();
});

// ── ANSI stripping ──────────────────────────────────────────────────────────

describe('ANSI stripping', () => {
  it('strips ANSI codes from raw content', () => {
    const entry: SessionLogEntry = {
      type: 'raw',
      content: '\u001B[4mHello\u001B[0m world',
      timestamp: '',
    };
    render(<EventRow entry={entry} />);
    expect(screen.getByText('Hello world')).toBeInTheDocument();
    expect(screen.queryByText(/\u001B/)).not.toBeInTheDocument();
  });

  it('strips ANSI codes from assistant text blocks', () => {
    const entry: SessionLogEntry = {
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: '\u001B[31mRed text\u001B[0m and plain' },
        ],
      },
      timestamp: '',
    };
    render(<EventRow entry={entry} />);
    expect(screen.getByText('Red text and plain')).toBeInTheDocument();
  });

  it('strips ANSI codes from tool result content', () => {
    const entry: SessionLogEntry = {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: '\u001B[32mSuccess\u001B[0m output',
            is_error: false,
          },
        ],
      },
      timestamp: '',
    };
    render(<EventRow entry={entry} />);
    expect(screen.getByText('Success output')).toBeInTheDocument();
  });

  it('handles content with multiple ANSI sequences', () => {
    const entry: SessionLogEntry = {
      type: 'raw',
      content: '\u001B[1m\u001B[33mBold yellow\u001B[0m \u001B[4munderlined\u001B[0m',
      timestamp: '',
    };
    render(<EventRow entry={entry} />);
    expect(screen.getByText('Bold yellow underlined')).toBeInTheDocument();
  });

  it('handles content without ANSI codes unchanged', () => {
    const entry: SessionLogEntry = {
      type: 'raw',
      content: 'Plain text no codes',
      timestamp: '',
    };
    render(<EventRow entry={entry} />);
    expect(screen.getByText('Plain text no codes')).toBeInTheDocument();
  });
});

// ── Collapsed tool calls ────────────────────────────────────────────────────

describe('collapsed tool calls', () => {
  it('shows collapsed tool call with ToolName and primary arg for Read', () => {
    const entry: SessionLogEntry = {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'Read',
            input: { file_path: 'src/index.ts' },
          },
        ],
      },
      timestamp: '',
    };
    render(<EventRow entry={entry} />);
    expect(screen.getByText(/Read/)).toBeInTheDocument();
    expect(screen.getByText(/src\/index\.ts/)).toBeInTheDocument();
    // Full JSON should NOT be visible when collapsed
    expect(screen.queryByText(/"file_path"/)).not.toBeInTheDocument();
  });

  it('shows collapsed tool call with Bash command preview', () => {
    const entry: SessionLogEntry = {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 't2',
            name: 'Bash',
            input: { command: 'git status --short' },
          },
        ],
      },
      timestamp: '',
    };
    render(<EventRow entry={entry} />);
    expect(screen.getByText(/Bash/)).toBeInTheDocument();
    expect(screen.getByText(/git status --short/)).toBeInTheDocument();
  });

  it('shows collapsed tool call with first value for unknown tools', () => {
    const entry: SessionLogEntry = {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 't3',
            name: 'CustomTool',
            input: { query: 'find something' },
          },
        ],
      },
      timestamp: '',
    };
    render(<EventRow entry={entry} />);
    expect(screen.getByText(/CustomTool/)).toBeInTheDocument();
    expect(screen.getByText(/find something/)).toBeInTheDocument();
  });

  it('truncates long primary args', () => {
    const longCommand = 'a'.repeat(100);
    const entry: SessionLogEntry = {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 't4',
            name: 'Bash',
            input: { command: longCommand },
          },
        ],
      },
      timestamp: '',
    };
    render(<EventRow entry={entry} />);
    // Should be truncated to 60 chars
    const button = screen.getByRole('button');
    expect(button.textContent).not.toContain(longCommand);
  });

  it('shows tool name alone when input is empty', () => {
    const entry: SessionLogEntry = {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 't5',
            name: 'SomeTool',
            input: {},
          },
        ],
      },
      timestamp: '',
    };
    render(<EventRow entry={entry} />);
    expect(screen.getByText(/SomeTool/)).toBeInTheDocument();
  });

  it('expands tool call on click to show full JSON', async () => {
    const user = userEvent.setup();
    const entry: SessionLogEntry = {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'Read',
            input: { file_path: 'src/index.ts' },
          },
        ],
      },
      timestamp: '',
    };
    render(<EventRow entry={entry} />);
    await user.click(screen.getByRole('button', { name: /Read/ }));
    expect(screen.getByText(/"file_path"/)).toBeInTheDocument();
  });

  it('recognizes file_path for Edit tool', () => {
    const entry: SessionLogEntry = {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 't6',
            name: 'Edit',
            input: {
              file_path: '/app/src/main.ts',
              old_string: 'foo',
              new_string: 'bar',
            },
          },
        ],
      },
      timestamp: '',
    };
    render(<EventRow entry={entry} />);
    expect(screen.getByText(/\/app\/src\/main\.ts/)).toBeInTheDocument();
  });

  it('recognizes file_path for Write tool', () => {
    const entry: SessionLogEntry = {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 't7',
            name: 'Write',
            input: { file_path: '/app/new-file.ts', content: 'hello' },
          },
        ],
      },
      timestamp: '',
    };
    render(<EventRow entry={entry} />);
    expect(screen.getByText(/\/app\/new-file\.ts/)).toBeInTheDocument();
  });

  it('recognizes pattern for Grep tool', () => {
    const entry: SessionLogEntry = {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 't8',
            name: 'Grep',
            input: { pattern: 'TODO', path: 'src/' },
          },
        ],
      },
      timestamp: '',
    };
    render(<EventRow entry={entry} />);
    expect(screen.getByText(/TODO/)).toBeInTheDocument();
  });

  it('recognizes pattern for Glob tool', () => {
    const entry: SessionLogEntry = {
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 't9',
            name: 'Glob',
            input: { pattern: '**/*.ts' },
          },
        ],
      },
      timestamp: '',
    };
    render(<EventRow entry={entry} />);
    expect(screen.getByText(/\*\*\/\*\.ts/)).toBeInTheDocument();
  });
});

// ── Error tool results ──────────────────────────────────────────────────────

describe('error tool results', () => {
  it('shows red border on error tool result', () => {
    const entry: SessionLogEntry = {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: 'Error: not found',
            is_error: true,
          },
        ],
      },
      timestamp: '',
    };
    const { container } = render(<EventRow entry={entry} />);
    // The error result row should have a red border class
    const errorRow = container.querySelector('.border-red-500');
    expect(errorRow).toBeInTheDocument();
  });

  it('does not show red border on success tool result', () => {
    const entry: SessionLogEntry = {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: 'Success output',
            is_error: false,
          },
        ],
      },
      timestamp: '',
    };
    const { container } = render(<EventRow entry={entry} />);
    const errorRow = container.querySelector('.border-red-500');
    expect(errorRow).not.toBeInTheDocument();
  });

  it('strips ANSI from error tool result content', () => {
    const entry: SessionLogEntry = {
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: '\u001B[31mError: file not found\u001B[0m',
            is_error: true,
          },
        ],
      },
      timestamp: '',
    };
    render(<EventRow entry={entry} />);
    expect(screen.getByText('Error: file not found')).toBeInTheDocument();
  });
});

// ── Null / suppressed entries ───────────────────────────────────────────────

describe('suppressed entries', () => {
  it('returns null for session_start', () => {
    const entry: SessionLogEntry = { type: 'session_start', timestamp: '' };
    const { container } = render(<EventRow entry={entry} />);
    expect(container.firstChild).toBeNull();
  });

  it('returns null for session_end', () => {
    const entry: SessionLogEntry = { type: 'session_end', timestamp: '' };
    const { container } = render(<EventRow entry={entry} />);
    expect(container.firstChild).toBeNull();
  });

  it('returns null for result type', () => {
    const entry: SessionLogEntry = { type: 'result', timestamp: '' };
    const { container } = render(<EventRow entry={entry} />);
    expect(container.firstChild).toBeNull();
  });

  it('returns null for raw entry with no content', () => {
    const entry: SessionLogEntry = { type: 'raw', timestamp: '' };
    const { container } = render(<EventRow entry={entry} />);
    expect(container.firstChild).toBeNull();
  });
});

// ── System events ───────────────────────────────────────────────────────────

describe('system events', () => {
  it('renders task_started with description', () => {
    const entry: SessionLogEntry = {
      type: 'system',
      subtype: 'task_started',
      description: 'Building project',
      timestamp: '',
    };
    render(<EventRow entry={entry} />);
    expect(screen.getByText('Building project')).toBeInTheDocument();
  });

  it('renders task_progress with description', () => {
    const entry: SessionLogEntry = {
      type: 'system',
      subtype: 'task_progress',
      description: '50% complete',
      timestamp: '',
    };
    render(<EventRow entry={entry} />);
    expect(screen.getByText('50% complete')).toBeInTheDocument();
  });

  it('suppresses unknown system subtypes', () => {
    const entry: SessionLogEntry = {
      type: 'system',
      subtype: 'unknown_thing',
      timestamp: '',
    };
    const { container } = render(<EventRow entry={entry} />);
    expect(container.firstChild).toBeNull();
  });
});
