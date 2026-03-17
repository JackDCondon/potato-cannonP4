// src/mcp/tools/chat.tools.ts

import type { ToolDefinition, McpContext, McpToolResult } from '../../types/mcp.types.js';
import { chatService } from '../../services/chat.service.js';
import type { ChatContext } from '../../providers/chat-provider.types.js';

const AGENT_HEADER_REGEX = /^(\s*)\[([^\]\n]*\bAgent\b[^\]\n]*)\]:(\s*)/;

export function toModelDisplayLabel(model: string | undefined): string | null {
  const trimmed = model?.trim();
  if (!trimmed) {
    return null;
  }

  const lower = trimmed.toLowerCase();
  if (lower.includes("opus")) return "Opus";
  if (lower.includes("sonnet")) return "Sonnet";
  if (lower.includes("haiku")) return "Haiku";
  if (/^o\d+$/i.test(trimmed)) return trimmed.toUpperCase();
  if (lower.startsWith("gpt-")) return `GPT${trimmed.slice(3)}`;

  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

export function formatAgentNotificationHeader(
  message: string,
  model: string | undefined,
): string {
  const modelLabel = toModelDisplayLabel(model);
  if (!modelLabel) {
    return message;
  }

  const match = message.match(AGENT_HEADER_REGEX);
  if (!match) {
    return message;
  }

  const leadingWhitespace = match[1];
  const agentLabel = match[2];
  const spacing = match[3];

  if (/\([^)\n]+\)\s*$/.test(agentLabel)) {
    return message;
  }

  return `${leadingWhitespace}[${agentLabel} (${modelLabel})]:${spacing}${message.slice(match[0].length)}`;
}

export const chatTools: ToolDefinition[] = [
  {
    name: 'chat_ask',
    scope: 'session',
    description:
      'Ask the user a question and wait for their response. Works via all connected chat providers.',
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The question to ask the user',
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of answer options to show as buttons',
        },
        phase: {
          type: 'string',
          description: 'Optional current phase (e.g., Refinement, Architecture) for context',
        },
},
      required: ['question'],
    },
  },
  {
    name: 'chat_notify',
    scope: 'session',
    description:
      'Send a notification to the user (does not wait for response). Works via all connected chat providers.',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'The notification message to send',
        },
      },
      required: ['message'],
    },
  },
  {
    name: 'chat_init',
    scope: 'session',
    description: 'Initialize chat threads for a ticket or brainstorm across all providers.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: {
          type: 'string',
          description: 'The ticket ID',
        },
        ticketTitle: {
          type: 'string',
          description: 'The ticket title',
        },
      },
      required: ['ticketId', 'ticketTitle'],
    },
  },
];

function toContext(ctx: McpContext): ChatContext {
  return {
    projectId: ctx.projectId,
    ticketId: ctx.ticketId || undefined,
    brainstormId: ctx.brainstormId || undefined,
    agentModel: ctx.agentModel || undefined,
  };
}

export const chatHandlers: Record<
  string,
  (ctx: McpContext, args: Record<string, unknown>) => Promise<McpToolResult>
> = {
  chat_ask: async (ctx, args) => {
    // All contexts use async flow — session suspends after asking.
    // The worker executor detects the pending question on exit and preserves state.
    // When the user responds, a new session resumes with --resume.
    await chatService.askAsync(
      toContext(ctx),
      args.question as string,
      args.options as string[] | undefined,
      args.phase as string | undefined
    );
    return {
      content: [
        {
          type: 'text',
          text: 'Question sent. Session will suspend — exit cleanly now. You will be resumed with the answer.',
        },
      ],
    };
  },

  chat_notify: async (ctx, args) => {
    const message = formatAgentNotificationHeader(
      args.message as string,
      ctx.agentModel,
    );
    await chatService.notify(toContext(ctx), message);
    return {
      content: [{ type: 'text', text: 'Notification sent' }],
    };
  },

  chat_init: async (ctx, args) => {
    const ticketId = (args.ticketId as string) || ctx.ticketId || ctx.brainstormId;
    const context = toContext(ctx);
    if (!context.ticketId && !context.brainstormId) {
      context.ticketId = ticketId;
    }

    await chatService.initChat(context, args.ticketTitle as string);
    return {
      content: [{ type: 'text', text: 'Chat initialized' }],
    };
  },
};
