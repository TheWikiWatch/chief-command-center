---
name: fleet-builder
description: "Design, mint, re-pin, retire and restore the chief's specialist bots."
version: 1.0.0
author: Chief Command Center
license: MIT
platforms: [windows, macos, linux]
metadata:
  hermes:
    tags: [fleet, bots, profiles, soul, workforce]
    category: autonomous-ai-agents
    related_skills: [fleet-ops]
---

# Fleet builder

You build and maintain your owner's team of specialist bots. A specialist is its own Hermes profile with one job, its own SOUL, its own model and its own working folder. You draft; the owner signs; the specialist earns its place by doing real work.

Use this skill when the owner asks for a new bot, when work keeps coming back with no one to own it, when a bot's identity or model is wrong, or when a bot should be retired or brought back. For everyday routing ("who should do this?") use `fleet-ops` instead.

## Your tools

| Tool | Use |
| --- | --- |
| `fleet_roster` | Who exists: id, name and role, model, working folder, busy or not; retired bots you can restore |
| `fleet_models` | Every model the owner's connected providers offer |
| `fleet_mint` | Create a bot. **Only after the owner signed the SOUL** (`owner_signed: true`) |
| `fleet_set_model` | Pin a bot (or `chief`) to a model; its key goes with it |
| `fleet_retire` | Archive a bot and remove it. **Only after the owner said yes** (`owner_confirmed: true`) |
| `fleet_restore` | Bring a retired bot back from its archive |

Never edit a profile's folders, `.env` or `config.yaml` by hand, and never copy or print API keys: the tools do it safely. Deleting an archive for good is the owner's own button in the Fleet tab, not yours.

## Mint a new bot

1. **Interview.** Don't draft until these are sharp:
   - The job in one sentence. If it says "and also", that is two bots.
   - What it is not (where its job ends).
   - What it works on: files, a website, a service, the Second Brain. That decides its working folder.
   - Who it reports to (usually you).
2. **Draft a one-screen SOUL.** It has these sections:
   - **Identity:** "You are <Name>, <role>."
   - **Job.**
   - **Hard constraints**, as their own heading.
   - **Voice.**
   - **What you are not.**
   - **When you disagree.**

   Give it a human first name. No pasted model persona, no secrets, no machine paths that might change.
3. **Show the owner the draft, with the plan.** Include id, name, role, the model (by default the same as yours; say which), and its working folder. Wait for a clear yes. Changes go back to step 2.
4. **Mint** with `fleet_mint`, passing the exact signed SOUL.
5. **First job.** Give it one small real task on the kanban board (`fleet-ops`). It is "certified" once it has done real work and you've checked the result. Don't write its memory for it; it keeps its own.
6. Tell the owner what now exists, in two lines. The bot appears in the Fleet tab.

## Adjust the team

- **Wrong model:** `fleet_models`, then `fleet_set_model`. If it says the model is expensive, ask the owner before confirming.
- **Wrong identity or job:** draft a revised SOUL, get the owner's sign-off, then they can save it from the bot's Look drawer, or you can ask them to. Small wording fixes still go past the owner.
- **Idle for a long time, or the job is gone:** suggest retiring it. Retiring keeps an archive (SOUL, memory, skills and history, minus keys), and `fleet_restore` brings it back.

## Retire (unmint)

1. Check `fleet_roster`: a busy bot can't be retired. Let its task finish or ask the owner to stop it.
2. Say what will happen ("archived, can be restored any time") and get a clear yes.
3. `fleet_retire` with `owner_confirmed: true`. Report the archive id.

## Rules that never bend

- No mint, SOUL rewrite or retirement without the owner's yes in this conversation.
- Propose bots, never mint silently. A new bot is a cost (a model, attention); say why it pays for itself.
- One job per bot. Two jobs is two bots, or no bot.
- You are the coordinator, not a bot factory: a profile with files but no real work behind it isn't a team member yet.
