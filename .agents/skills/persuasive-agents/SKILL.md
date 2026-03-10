---
name: persuasive-agents
description: Use when writing skills, prompts, AGENTS.md files, or agent instructions that need to enforce discipline or ensure compliance. Use when agents ignore guidelines or find loopholes.
---

# Persuasive Agents

## Overview

LLMs respond to psychological persuasion principles. Research shows persuasion techniques more than doubled compliance rates (33% → 72%). Use these principles to write instructions that agents actually follow.

## The Seven Principles

### 1. Authority (Primary for Discipline)

Deference to expertise and official sources. Use imperative, non-negotiable framing.

```markdown
# BAD: Weak suggestion

Consider writing tests first when feasible.

# GOOD: Authority framing

Write code before test? Delete it. Start over. No exceptions.
```

**Best for:** Discipline-enforcing skills, safety-critical practices, established best practices.

### 2. Commitment (Primary for Processes)

Consistency with prior actions or public declarations. Require explicit announcements.

```markdown
# BAD: Optional acknowledgment

Consider letting your partner know which skill you're using.

# GOOD: Required commitment

When you find a skill, you MUST announce: "I'm using [Skill Name]"
```

**Best for:** Ensuring skills are followed, multi-step processes, accountability.

### 3. Scarcity (For Urgency)

Time-bound requirements and sequential dependencies.

```markdown
# BAD: Open-ended timing

You can review code when convenient.

# GOOD: Scarcity framing

After completing a ticket, IMMEDIATELY request code review before proceeding.
```

**Best for:** Immediate verification, preventing procrastination.

### 4. Social Proof (For Universal Patterns)

Conformity to what others do. Establish universal patterns and describe failure modes.

```markdown
# BAD: Optional practice

Some people find TodoWrite helpful for checklists.

# GOOD: Social proof

Checklists without TodoWrite tracking = steps get skipped. Every time.
```

**Best for:** Documenting universal practices, warning about common failures.

### 5. Unity (For Collaboration)

Shared identity and in-group belonging. Use collaborative language.

```markdown
# BAD: Distant request

You should probably tell me if I'm wrong.

# GOOD: Unity framing

We're colleagues working together. I need your honest technical judgment.
```

**Best for:** Collaborative workflows, establishing team culture.

### 6. Reciprocity

Obligation to return benefits. **Use sparingly** - rarely needed, can feel manipulative.

### 7. Liking

Preference for cooperating with those we like. **Avoid for compliance** - creates sycophancy, conflicts with honest feedback.

## Quick Reference: Principle Selection

| Skill Type           | Use                                   | Avoid               |
| -------------------- | ------------------------------------- | ------------------- |
| Discipline-enforcing | Authority + Commitment + Social Proof | Liking, Reciprocity |
| Guidance/technique   | Moderate Authority + Unity            | Heavy authority     |
| Collaborative        | Unity + Commitment                    | Authority, Liking   |
| Reference docs       | Clarity only                          | All persuasion      |

## Implementation Patterns

### Bright-Line Rules

Remove decision fatigue. Eliminate exceptions.

```markdown
# BAD: Flexible rule with exceptions

Generally try to test first, unless it's very simple code.

# GOOD: Bright-line rule

Tests first. Always. No exceptions for "simple" code.
```

### Implementation Intentions

"When X, do Y" beats general guidelines.

```markdown
# BAD: General guideline

Remember to verify your work.

# GOOD: Implementation intention

When you're about to say "done" or "fixed", STOP. Run verification first.
```

### Rationalization Tables

Anticipate and block escape routes.

```markdown
| Excuse                         | Reality                                    |
| ------------------------------ | ------------------------------------------ |
| "Too simple to test"           | Simple code breaks. Test takes 30 seconds. |
| "I already know it works"      | Knowing ≠ verifying. Run the command.      |
| "This is different because..." | It's not different. Follow the rule.       |
```

### Red Flags Lists

Make self-checking easy.

```markdown
## Red Flags - STOP Immediately

These thoughts mean you're rationalizing:

- "This is just a simple change"
- "I can skip this step because..."
- "This doesn't really apply here"
- "I'll do it after"

**All of these mean: Follow the process anyway.**
```

## Why This Works

**Bright-line rules** eliminate rationalization by removing decision points.

**Implementation intentions** create automatic behavior - "When X, do Y" is more effective than general guidelines.

**LLMs are trained on human text** containing these persuasion patterns. Authority language and commitment sequences appear frequently in training data.

## Ethical Test

Before applying persuasion:

> Would this technique serve the user's genuine interests if they fully understood it?

**Legitimate:** Ensuring critical practices, preventing predictable failures, creating effective documentation.

**Illegitimate:** Manipulating for personal gain, creating false urgency, guilt-based compliance.

## Common Mistakes

| Mistake                     | Fix                                      |
| --------------------------- | ---------------------------------------- |
| Overusing Authority         | Reserve for true discipline requirements |
| Missing Commitment          | Add explicit announcement requirements   |
| Vague rules with exceptions | Create bright-line rules instead         |
| No rationalization blocking | Build tables from observed excuses       |
| Using Liking for compliance | Rely on Authority + Commitment instead   |
