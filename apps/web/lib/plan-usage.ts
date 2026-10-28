import type { NousPlan, PlanGauge } from "@/lib/fleet-client";

/**
 * A Nous plan with usage windows (Hermes 0.22.5), with the same rules as Hermes's own pickers
 * (`hermes_cli/model_picker_usage.py`): an allowance covers every model, or only Large ones; a full one stops the
 * models it covers unless credits pay; a Free model is never stopped.
 */

const NAMES: Record<string, string> = { day: "Today", week: "This week", month: "This month", top_tier: "Large models" };
const LIMIT_NAMES: Record<string, string> = { day: "Daily", week: "Weekly", month: "Monthly", top_tier: "Large-model" };

/** "Today", "This week", "Large models", or the server's own title for an allowance it adds. */
export const gaugeName = (g: PlanGauge) => NAMES[g.label] || g.title || g.label;

const limitName = (g: PlanGauge) => LIMIT_NAMES[g.label] || g.title || "Plan";

export const isFree = (plan: NousPlan, model: string) => plan.free.includes(model) || model.endsWith(":free");
export const isLarge = (plan: NousPlan, model: string) => plan.large.includes(model);

/** The full allowance that stops this model (of several, the one that refills last), or null while it has room. */
export function spentFor(plan: NousPlan, model: string): PlanGauge | null {
  if (isFree(plan, model)) return null;
  const covering = plan.gauges.filter((g) => g.scope === "all" || (g.scope === "large" && isLarge(plan, model)));
  const spent = covering.filter((g) => g.full);
  return spent.length ? spent.reduce((a, b) => ((b.resetsAt || 0) > (a.resetsAt || 0) ? b : a)) : null;
}

/** A full allowance stops this model and credits won't pay for it. */
export const blocks = (plan: NousPlan, model: string) => plan.creditsPay !== true && spentFor(plan, model) !== null;

/** "Weekly limit reached · resets in 21h · only Free models until then", once an allowance is full (null otherwise,
 * and while the plan is paused: that's said on its own). */
export function limitLine(plan: NousPlan, now = Date.now() / 1000): string | null {
  if (plan.paused) return null;
  const latest = (gs: PlanGauge[]) => (gs.length ? gs.reduce((a, b) => ((b.resetsAt || 0) > (a.resetsAt || 0) ? b : a)) : null);
  const all = latest(plan.gauges.filter((g) => g.scope === "all" && g.full));
  const g = all || plan.gauges.find((x) => x.scope === "large" && x.full);
  if (!g) return null;
  const head = `${limitName(g)} limit reached${g.resetsAt ? ` · resets ${resetsIn(g.resetsAt, now)}` : ""}`;
  if (plan.creditsPay === true) return `${head} · ${all ? "paid models now use your credits" : "Large models now use your credits"}`;
  if (plan.creditsPay === false) return `${head} · ${all ? "only Free models until then" : "Large models paused until then"}`;
  return head;
}

/** "in 3d", "in 5h", "in 20m", "soon". */
export function resetsIn(at: number, now = Date.now() / 1000): string {
  const s = Math.max(0, at - now);
  if (s >= 86_400) return `in ${Math.round(s / 86_400)}d`;
  if (s >= 3_600) return `in ${Math.round(s / 3_600)}h`;
  if (s >= 60) return `in ${Math.round(s / 60)}m`;
  return "soon";
}

/** "Free" or "Large", the words Hermes's pickers show; nothing for the rest. */
export const sizeWord = (plan: NousPlan, model: string) => (isFree(plan, model) ? "Free" : isLarge(plan, model) ? "Large" : "");

/** The plan's picks first, in its order, then the rest as they were. */
export function featuredFirst(plan: NousPlan | null | undefined, models: string[]) {
  if (!plan?.featured.length) return models;
  const picks = plan.featured.filter((m) => models.includes(m));
  return [...picks, ...models.filter((m) => !picks.includes(m))];
}

/** The allowance closest to full, for a one-word summary. */
export const fullest = (plan: NousPlan) => (plan.gauges.length ? plan.gauges.reduce((a, b) => (b.used > a.used ? b : a)) : null);
