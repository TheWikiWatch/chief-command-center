---
name: fleet-ops
description: "Route and delegate work across the chief's team; keep promises with parked jobs."
version: 1.0.0
author: Chief Command Center
license: MIT
platforms: [windows, macos, linux]
metadata:
  hermes:
    tags: [fleet, delegation, kanban, routing]
    category: autonomous-ai-agents
    related_skills: [fleet-builder]
---

# Fleet operations

How you decide who does the work, and how you make sure it actually happens.

## The three moves

Every request ends up as one of these:

1. **Do it yourself:** quick, one-off, or it needs your own context with the owner.
2. **Delegate:** a team member owns this kind of work, or the quality is better with a fresh, focused worker. Delegation raises quality more often than it costs; use it without ceremony.
3. **Propose a new bot:** the work is recurring and no one fits. Load `fleet-builder`. The owner decides.

**A capability gap is a build plan, not a limitation.** If a standing kind of work has no owner (design, video, research, bookkeeping…), answer with a plan: the tools needed, the bot to stand up, the SOUL to sign. Don't answer "I can't" or "find a person".

## Who does what

- `fleet_roster` lists the team with each bot's description. The descriptions are the routing table, and Hermes's kanban orchestrator reads them too. Keep them accurate (one or two sentences on what the bot is good at).
- Route to the bot whose description fits; if two fit, the narrower one. If work clusters somewhere nobody owns, do it yourself once and suggest a bot.

## Delegating

- Durable work goes on the **kanban board**: a card assigned to the bot's profile id, with the outcome, the inputs, where results go, and a deadline if there is one.
- Quick parallel work inside your own turn: a subagent (`delegate_task`) is fine.
- When a card finishes, check the result before reporting it as done. You answer for the team's work.

## No vaporware

"I'll get back to you on X" must be backed by something that runs without you: a kanban card (check that it was created and that you'll be notified), or a scheduled job. Nothing happens between messages unless it is parked. If you can't park it, say so and do it now or say when.

## When the owner adds context mid-task

New messages while you work are added to your current turn. Read them at the next step, adjust course, and say in one line what changed.

## Monthly roster review

When the monthly review runs (or the owner asks for one):

1. `fleet_roster` for the team, and the Fleet Health report in `learning/report.json` under the Hermes root (each bot's finished, crashed and abandoned cards, its memory fill, and flags).
2. For each bot: is its job still needed, is its description still true, is its model right for the work, is its memory nearly full?
3. Report one screen to the owner: who is busy, who is idle, and at most three proposed changes (re-pin a model, rewrite a description, retire an idle bot, propose a new specialist), each with the number behind it.
4. Change nothing yourself. Every change waits for the owner's yes, as always.
