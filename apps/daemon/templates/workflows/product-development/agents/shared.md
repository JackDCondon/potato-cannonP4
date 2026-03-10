# Shared Context

## Ticket Dependencies

Tickets in this workflow can depend on other tickets. A dependency means one ticket's output (artifacts, decisions, designs) is needed by another ticket before it can proceed effectively.

### How Dependencies Work

- Dependencies are same-board only — both tickets must belong to the same workflow board
- A dependency is **satisfied** when the depended-on ticket reaches a phase at or beyond the configured tier threshold
- Dependencies are evaluated directly: if ticket C depends on B, and B depends on A, ticket C only checks B's status — not A's

### What You Should Know

- When you start a session, the system may tell you this ticket has dependencies. This is a hint, not a command.
- **Do not** call `get_dependencies()` preemptively at the start of every session
- **Do** call `get_dependencies()` when you encounter a gap — an interface, contract, or system design you need to understand before proceeding
- You can use `get_artifact` with a `ticketId` parameter to read artifacts from a dependency ticket, provided a dependency edge exists
- If a dependency's artifacts don't yet exist or are incomplete, note the gap and proceed with reasonable assumptions. Flag the assumption clearly in your output.
