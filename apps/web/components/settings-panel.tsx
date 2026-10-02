"use client";

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState, type ReactNode, type UIEvent } from "react";

import {
  AudioLinesIcon,
  BellIcon,
  CheckIcon,
  PlayIcon,
  RefreshCwIcon,
  SlidersHorizontalIcon,
  SquareIcon,
  VibrateIcon,
  Volume2Icon,
  ZapIcon,
  BotIcon,
  BookOpenIcon,
  HardDriveDownloadIcon,
  KeyRoundIcon,
  ChartColumnIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  InfoIcon,
  SmartphoneIcon,
  PencilIcon,
  XIcon,
} from "@/components/icons";
import { BackupPanel } from "@/components/backup/backup-panel";
import { UpdatesPanel, useUpdates } from "@/components/updates/update-card";
import { UpdateHistoryButton } from "@/components/updates/update-history";
import { PhoneSettings } from "@/components/phone/phone-settings";
import { Sheet } from "@/components/ui/sheet";
import { Group, Row } from "@/components/ui/settings-group";
import { Segmented, Switch } from "@/components/ui/controls";
import { fetchSettings, patchSettings, speakText, type HermesSettings, type SettingsProvider, type VoiceChoice } from "@/lib/bridge";
import { FONT_STEPS, notifyVoiceConfig, useDashboardPrefs } from "@/lib/dashboard-prefs";
import { canVibrate, PREVIEW_VARIANT, previewHaptic, previewSound } from "@/lib/fx";
import {
  FX_EVENT_LABELS,
  FX_EVENTS,
  updateFx,
  useFxPrefs,
  type AmbientPref,
  type FxEvent,
  type MotionPref,
  type UiScale,
} from "@/lib/fx-prefs";
import { EASE, SPRING } from "@/lib/motion";
import { toggleFullscreen, useFullscreen } from "@/lib/use-fullscreen";
import { stopSpeech } from "@/lib/voice-client";
import { enableWebPush, pushCapability, pushStatus, type PushStatus } from "@/lib/web-push";
import { useAssistantName, ownerName, setAssistantTitle } from "@/lib/identity";
import { NameEditor } from "@/components/persona/name-editor";
import { UsagePage } from "@/components/usage/usage-page";
import { fetchAbout, type AboutInfo } from "@/lib/about-client";
import { splitTitle } from "@/lib/names";
import type { Person } from "@/lib/types";
import { openTeam, type SettingsCategory } from "@/lib/settings-nav";
import { ConnectModel } from "@/components/onboarding/connect-model";
import { PersonaEditor } from "@/components/persona/persona-editor";
import { ModelsKeys } from "@/components/fleet/models-keys";
import { FORMAT_INFO, SecondBrainSetup } from "@/components/second-brain/setup";
import { CheckMySystem } from "@/components/voice/check-my-system";
import { loadVoiceCheck, type VoiceCheckResult } from "@/lib/mic-device";
import { secondBrain, setup, type Routine, type SecondBrainStatus, type SetupStatus } from "@/lib/setup-client";
import { useAppConfig } from "@/lib/app-config";

type ApplyBody = {
  stt?: { provider?: string; model?: string; api_key?: string };
  tts?: { provider?: string; voice?: string; api_key?: string };
  secrets?: Record<string, string>;
};

/** App and Hermes voice settings in a sheet (bottom on the phone, side panel on desktop). */
const CATEGORIES: { id: SettingsCategory; label: string; blurb: string; Icon: (p: { className?: string }) => ReactNode }[] = [
  { id: "general", label: "General", blurb: "Names, identity and how this app looks.", Icon: ({ className }) => <SlidersHorizontalIcon className={className} /> },
  { id: "models", label: "Models & keys", blurb: "The model the chief thinks with, and the providers your bots can use.", Icon: ({ className }) => <KeyRoundIcon className={className} /> },
  { id: "voice", label: "Voice", blurb: "How the chief speaks and listens.", Icon: ({ className }) => <AudioLinesIcon className={className} /> },
  { id: "second-brain", label: "Second Brain", blurb: "Your notes folder and its routines.", Icon: ({ className }) => <BookOpenIcon className={className} /> },
  { id: "notifications", label: "Notifications", blurb: "Alerts, sounds and vibration on this device.", Icon: ({ className }) => <BellIcon className={className} /> },
  { id: "phone", label: "Phone", blurb: "Use the app on your phone, privately, with alerts.", Icon: ({ className }) => <SmartphoneIcon className={className} /> },
  { id: "usage", label: "Usage", blurb: "Tokens and cost for the chief and every bot, and your budget.", Icon: ({ className }) => <ChartColumnIcon className={className} /> },
  { id: "backup", label: "Backup & updates", blurb: "Copies of your setup, and new versions of the app.", Icon: ({ className }) => <HardDriveDownloadIcon className={className} /> },
  { id: "about", label: "About", blurb: "Versions, licences and credits.", Icon: ({ className }) => <InfoIcon className={className} /> },
];
const CATEGORY_KEY = "chief-settings-category";

function rememberedCategory(): SettingsCategory {
  try {
    const saved = localStorage.getItem(CATEGORY_KEY) as SettingsCategory | null;
    return saved && CATEGORIES.some((c) => c.id === saved) ? saved : "general";
  } catch {
    return "general";
  }
}

/**
 * Settings: one window with a list of categories. Desktop: a centred window, categories down the left and
 * the page beside them. Phone: the category list, then the page, with a back button. The category last
 * opened on this device is remembered.
 */
export function SettingsPanel({
  open,
  phone,
  onClose,
  onAskChief,
  chief,
  category,
}: {
  open: boolean;
  phone: boolean;
  onClose: () => void;
  onAskChief?: (text: string) => Promise<void>;
  /** The chief's roster entry (its name and role, for General). */
  chief?: Person;
  /** Open at this category (otherwise the last one used on this device). */
  category?: SettingsCategory | null;
}) {
  return (
    <Sheet open={open} onClose={onClose} side={phone ? "bottom" : "center"} tall bare labelledBy="settings-title">
      <SettingsWindow phone={phone} onClose={onClose} onAskChief={onAskChief} chief={chief} initial={category ?? null} />
    </Sheet>
  );
}

function SettingsWindow({
  phone,
  onClose,
  onAskChief,
  chief,
  initial,
}: {
  phone: boolean;
  onClose: () => void;
  onAskChief?: (text: string) => Promise<void>;
  chief?: Person;
  initial: SettingsCategory | null;
}) {
  // Phone starts at the list unless a category was asked for; desktop always shows a page.
  const [current, setCurrent] = useState<SettingsCategory | null>(() => initial ?? (phone ? null : rememberedCategory()));
  // The page scrolls under a fixed header; a divider appears once it has moved, and a new category starts at the top.
  // tabIndex -1 lets a click inside the page focus it, so Page Down and the arrow keys scroll it too.
  const scroller = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);
  const onScroll = (e: UIEvent<HTMLDivElement>) => setScrolled(e.currentTarget.scrollTop > 2);
  const choose = (id: SettingsCategory | null) => {
    setCurrent(id);
    scroller.current?.scrollTo({ top: 0 });
    setScrolled(false);
    if (!id) return;
    try {
      localStorage.setItem(CATEGORY_KEY, id);
    } catch {
      /* private mode */
    }
  };
  const meta = CATEGORIES.find((c) => c.id === current);
  const page = current ? <CategoryPage id={current} phone={phone} onAskChief={onAskChief} chief={chief} /> : null;

  if (phone) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <header className={`flex shrink-0 items-center gap-2 border-b px-3 pb-2 transition-colors ${scrolled ? "border-line" : "border-transparent"}`}>
          {meta ? (
            <button type="button" onClick={() => choose(null)} className="press flex min-h-11 items-center gap-1 rounded-full pl-1 pr-3 text-callout text-fg-2 hover:text-fg" aria-label="Back to Settings">
              <ChevronLeftIcon size={18} />
              Settings
            </button>
          ) : null}
          <h2 id="settings-title" className={`min-w-0 flex-1 truncate text-title text-fg ${meta ? "sr-only" : "pl-2"}`}>
            {meta ? meta.label : "Settings"}
          </h2>
          <button type="button" onClick={onClose} aria-label="Close settings" className="press grid size-11 place-items-center rounded-full text-fg-2 hover:bg-white/6 hover:text-fg">
            <XIcon size={18} />
          </button>
        </header>
        <div ref={scroller} tabIndex={-1} data-scroll-region onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          <AnimatePresence mode="popLayout" initial={false}>
            {meta ? (
              <motion.div key={meta.id} initial={{ x: 40, opacity: 0 }} animate={{ x: 0, opacity: 1, transition: { duration: 0.22, ease: EASE.enter } }} exit={{ x: 40, opacity: 0, transition: { duration: 0.14 } }} className="px-4 pb-10">
                <h3 className="text-display text-fg">{meta.label}</h3>
                <p className="mb-5 mt-1 text-callout text-fg-3">{meta.blurb}</p>
                {page}
              </motion.div>
            ) : (
              <motion.ul key="list" initial={{ x: -30, opacity: 0 }} animate={{ x: 0, opacity: 1, transition: { duration: 0.2, ease: EASE.enter } }} exit={{ x: -30, opacity: 0, transition: { duration: 0.12 } }} className="mx-4 divide-y divide-(--line-1) overflow-hidden rounded-card border border-line bg-card">
                {CATEGORIES.map(({ id, label, blurb, Icon }) => (
                  <li key={id}>
                    <button type="button" onClick={() => choose(id)} className="press flex min-h-14 w-full items-center gap-3 px-3.5 py-2.5 text-left hover:bg-white/3">
                      <span className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-white/6 text-fg-2">
                        <Icon className="size-4" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-body text-fg">{label}</span>
                        <span className="block truncate text-caption text-fg-3">{blurb}</span>
                      </span>
                      <ChevronRightIcon size={16} className="shrink-0 text-fg-3" />
                    </button>
                  </li>
                ))}
              </motion.ul>
            )}
          </AnimatePresence>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      <nav aria-label="Settings" className="flex w-[240px] shrink-0 flex-col border-r border-line bg-pane/60 p-3">
        <h2 id="settings-title" className="px-2 pb-3 pt-1 text-title text-fg">
          Settings
        </h2>
        <ul className="space-y-0.5">
          {CATEGORIES.map(({ id, label, Icon }) => {
            const on = current === id;
            return (
              <li key={id}>
                <button
                  type="button"
                  aria-current={on ? "page" : undefined}
                  onClick={() => choose(id)}
                  className={`press relative flex min-h-10 w-full items-center gap-3 rounded-ctl px-2.5 text-left text-callout transition-colors ${on ? "text-fg" : "text-fg-2 hover:bg-white/4 hover:text-fg"}`}
                >
                  {on ? <motion.span layoutId="settings-nav" className="absolute inset-0 rounded-ctl bg-white/8" transition={SPRING.snappy} /> : null}
                  <Icon className={`relative size-4 ${on ? "text-fg" : "text-fg-3"}`} />
                  <span className="relative">{label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <section aria-labelledby="settings-page-title" className="flex min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-start gap-3 border-b border-line px-7 pb-4 pt-5">
          <div className="min-w-0 flex-1">
            <h3 id="settings-page-title" className="text-display text-fg">
              {meta?.label}
            </h3>
            <p className="mt-1 text-callout text-fg-3">{meta?.blurb}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close settings" className="press -mr-2 grid size-10 place-items-center rounded-full text-fg-2 hover:bg-white/6 hover:text-fg">
            <XIcon size={18} />
          </button>
        </header>
        <div ref={scroller} tabIndex={-1} data-scroll-region className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-7 pb-12 pt-6">
          <div key={current} className="mx-auto max-w-[680px]">
            {page}
          </div>
        </div>
      </section>
    </div>
  );
}

function CategoryPage({
  id,
  phone,
  onAskChief,
  chief,
}: {
  id: SettingsCategory;
  phone: boolean;
  onAskChief?: (text: string) => Promise<void>;
  chief?: Person;
}) {
  return (
    <div className="space-y-7">
      {id === "general" ? (
        <>
          <ChiefNameGroup chief={chief} />
          <IdentityGroup />
          <AppGroup phone={phone} />
        </>
      ) : id === "models" ? (
        <>
          <ConnectionGroup />
          <ModelsKeysGroup />
        </>
      ) : id === "voice" ? (
        <VoiceGroup />
      ) : id === "second-brain" ? (
        <SecondBrainGroup onAskChief={onAskChief} />
      ) : id === "notifications" ? (
        <>
          <NotificationsGroup />
          <SoundGroup />
          <HapticsGroup />
        </>
      ) : id === "phone" ? (
        <PhoneSettings />
      ) : id === "usage" ? (
        <UsagePage />
      ) : id === "backup" ? (
        <>
          <BackupGroup />
          <UpdatesGroup />
        </>
      ) : (
        <AboutGroup />
      )}
    </div>
  );
}

/** General: the chief's name and role (any other bot is renamed from its Look drawer). */
function ChiefNameGroup({ chief }: { chief?: Person }) {
  const assistant = useAssistantName();
  const parts = splitTitle(chief?.name);
  const [shown, setShown] = useState({ name: parts.name || assistant, role: parts.role || "" });
  useEffect(() => setShown({ name: splitTitle(chief?.name).name || assistant, role: splitTitle(chief?.name).role || "" }), [chief?.name, assistant]);
  const [editing, setEditing] = useState(false);
  const [note, setNote] = useState("");
  return (
    <Group
      icon={<PencilIcon className="size-4" />}
      title="Name"
      hint="What the chief is called everywhere. Rename any other bot from its card in Fleet."
      action={
        editing ? null : (
          <button type="button" onClick={() => setEditing(true)} className="press min-h-9 rounded-full border border-line-2 px-3 text-callout text-fg-2 hover:text-fg">
            Rename
          </button>
        )
      }
    >
      {editing ? (
        <div className="px-3.5 py-3">
          <NameEditor
            profile="chief"
            name={shown.name}
            role={shown.role}
            onCancel={() => setEditing(false)}
            onSaved={(res) => {
              setShown({ name: res.name, role: res.role });
              setAssistantTitle(res.title);
              setEditing(false);
              setNote(res.soul === "updated" ? "Saved. The SOUL uses the new name too." : res.soul.startsWith("kept") ? "Saved. The SOUL opens differently, so it was left as it is." : "Saved.");
            }}
          />
        </div>
      ) : (
        <Row label={shown.name} hint={note || shown.role || "No role set"} />
      )}
    </Group>
  );
}

/** About: what this is built from, and whose work it carries. */
function AboutGroup() {
  const [about, setAbout] = useState<AboutInfo | null>(null);
  useEffect(() => {
    void fetchAbout()
      .then(setAbout)
      .catch(() => setAbout(null));
  }, []);
  return (
    <>
      <Group icon={<InfoIcon className="size-4" />} title="Chief Command Center" action={<UpdateHistoryButton />}>
        <Row label="Version" hint={about?.app || "…"} />
        <Row label="Hermes Agent" hint={about ? `${about.hermes || "version unknown"}, by Nous Research (MIT)` : "…"} />
        <Row
          label="Hermes updates"
          hint="Hermes is built into the app and never updates itself. A newer Hermes reaches you as an app update, once it passes the app's compatibility checks; the app backs up your data before Hermes first starts on it."
        />
        <Row label="Licence" hint="MIT. Your data stays on this computer unless you send it somewhere." />
      </Group>
      <Group icon={<BookOpenIcon className="size-4" />} title="Bundled with credit">
        <Row
          label={about?.toolkit ? `obsidian-second-brain ${about.toolkit.version}` : "obsidian-second-brain"}
          hint={`The Second Brain skills and routines, by Eugeniu Ghelbur (MIT). ${about?.toolkit?.source || "github.com/eugeniughelbur/obsidian-second-brain"}`}
        />
      </Group>
    </>
  );
}

/* ------------------------------------------------------------------ Connection (the chief's model) */

function ConnectionGroup() {
  const assistant = useAssistantName();
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [error, setError] = useState("");
  const [changing, setChanging] = useState(false);
  const load = () => {
    setError("");
    setup
      .status()
      .then(setStatus)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Couldn't read the connection."));
  };
  useEffect(load, []);
  return (
    <Group
      icon={<ZapIcon className="size-4" />}
      title="Connection"
      hint={`The model ${assistant} thinks with. Changes apply to new conversations.`}
      action={
        <button type="button" onClick={() => setChanging((v) => !v)} className="press min-h-9 rounded-full border border-line-2 px-3 text-callout text-fg-2 hover:text-fg">
          {changing ? "Close" : "Change"}
        </button>
      }
    >
      {changing ? (
        <div className="px-1 py-2">
          <ConnectModel
            onDone={(s) => {
              setStatus(s);
            }}
          />
        </div>
      ) : (
        <Row label={status?.model || (status ? "No model chosen" : "…")} hint={error || (status ? (status.ready ? `via ${status.provider}` : status.error || "Not connected") : "")}>
          {status ? (
            <span className={`rounded-full px-2 py-0.5 text-caption ${status.ready ? "bg-ok/15 text-ok" : "bg-warn/15 text-warn"}`}>{status.ready ? "Ready" : "Needs setup"}</span>
          ) : null}
        </Row>
      )}
    </Group>
  );
}

/** Every provider this install can use; their models fill each bot's model list. */
function ModelsKeysGroup() {
  return (
    <Group icon={<KeyRoundIcon className="size-4" />} title="Models & keys" hint="Providers your bots can use. Pick each bot's model from its Look drawer, under Job.">
      <ModelsKeys />
    </Group>
  );
}

/* ------------------------------------------------------------------ Updates (desktop app only) */

function UpdatesGroup() {
  const { api } = useUpdates();
  if (!api) return null;
  return (
    <Group icon={<RefreshCwIcon className="size-4" />} title="Updates" hint="New versions of the app, including its tested Hermes." action={<UpdateHistoryButton />}>
      <div className="px-3 py-3">
        <UpdatesPanel />
      </div>
    </Group>
  );
}

/* ------------------------------------------------------------------ Backup & restore */

function BackupGroup() {
  const [open, setOpen] = useState(false);
  return (
    <Group
      icon={<HardDriveDownloadIcon className="size-4" />}
      title="Backup & restore"
      hint="Your setup and Second Brain, to a folder you choose."
      action={
        <button type="button" onClick={() => setOpen((v) => !v)} className="press min-h-9 rounded-full border border-line-2 px-3 text-callout text-fg-2 hover:text-fg">
          {open ? "Close" : "Open"}
        </button>
      }
    >
      {open ? (
        <div className="px-3 py-3">
          <BackupPanel />
        </div>
      ) : (
        <BackupSummaryRow />
      )}
    </Group>
  );
}

function BackupSummaryRow() {
  const [line, setLine] = useState("…");
  useEffect(() => {
    import("@/lib/backup-client").then(({ backups, agoLabel }) =>
      backups
        .status()
        .then((s) =>
          setLine(!s.ok ? s.error || "Not available on this install." : s.lastBackup ? `Last backup: ${agoLabel(s.lastBackup.at)}${s.remind ? " — time for a new one" : ""}` : s.settings.folder ? "No backups yet." : "Not set up yet."),
        )
        .catch(() => setLine("Not available right now.")),
    );
  }, []);
  return <Row label={line} />;
}

/* ------------------------------------------------------------------ Check my system */

function describeCheck(r: VoiceCheckResult | null): string {
  if (!r) return "Not run on this device yet.";
  const parts = [
    r.mic === "ok" ? "microphone works" : r.mic === "skipped" ? "" : "microphone needs attention",
    r.speaker === "heard" ? "speakers work" : r.speaker === "skipped" ? "" : "speakers need attention",
    r.typing === "ok" ? "voice typing works" : r.typing === "not-set-up" ? "voice typing not set up" : r.typing === "skipped" ? "" : "voice typing needs attention",
  ].filter(Boolean);
  const when = new Date(r.at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return parts.length ? `${when}: ${parts.join(", ")}.` : `${when}: skipped.`;
}

function SystemCheckRow() {
  const [open, setOpen] = useState(false);
  const [last, setLast] = useState<VoiceCheckResult | null>(null);
  useEffect(() => setLast(loadVoiceCheck()), [open]);
  return (
    <div className="rounded-ctl bg-white/3 px-3 py-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-body text-fg">Check my system</p>
          <p className="mt-0.5 text-caption text-fg-3">{describeCheck(last)}</p>
        </div>
        <button type="button" onClick={() => setOpen((v) => !v)} className="press min-h-9 shrink-0 rounded-full border border-line-2 px-3 text-callout text-fg-2 hover:text-fg">
          {open ? "Close" : "Run"}
        </button>
      </div>
      {open ? (
        <div className="mt-3">
          <CheckMySystem onResult={setLast} />
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ Second Brain */

const MODE_LABEL: Record<string, string> = { new: "The Second Brain layout", keep: "Your own folders", reorganize: "Being reorganized" };

function SecondBrainGroup({ onAskChief }: { onAskChief?: (text: string) => Promise<void> }) {
  const config = useAppConfig();
  const [status, setStatus] = useState<SecondBrainStatus | null>(null);
  const [error, setError] = useState("");
  const [changing, setChanging] = useState(false);
  const load = () => {
    setError("");
    secondBrain
      .status()
      .then(setStatus)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Couldn't read the Second Brain."));
  };
  useEffect(load, []);
  const fromEnv = config.secondBrain.source === "env";
  const path = fromEnv ? config.vaultRoot : status?.path || "";
  return (
    <Group
      icon={<BookOpenIcon className="size-4" />}
      title="Second Brain"
      hint="Your notes folder. Today reads its tasks; Vault browses it."
      action={
        fromEnv ? null : (
          <button
            type="button"
            onClick={() => {
              setChanging((v) => !v);
              if (changing) load();
            }}
            className="press min-h-9 rounded-full border border-line-2 px-3 text-callout text-fg-2 hover:text-fg"
          >
            {changing ? "Close" : status?.configured ? "Change" : "Set up"}
          </button>
        )
      }
    >
      {changing ? (
        <div className="px-1 py-2">
          <SecondBrainSetup onAskChief={onAskChief} onDone={load} />
        </div>
      ) : (
        <>
          <Row
            label={path ? <span className="break-all font-mono text-code">{path}</span> : status ? "Not set up" : "…"}
            hint={
              error ||
              (fromEnv
                ? "Set by this install's configuration (CHIEF_VAULT_PATH)."
                : status?.configured
                  ? `${status.exists ? (status.format ? `${FORMAT_INFO[status.format].label}${status.rules ? ` · follows ${status.rules}` : ""}` : MODE_LABEL[status.mode || ""] || "Connected") : "The folder is missing"}${config.secondBrain.today === "ops" ? " · Today uses your task service" : ""}`
                  : "Choose a folder to keep notes and tasks with your chief.")
            }
          />
          {status?.configured && !fromEnv ? <RoutineRows /> : null}
        </>
      )}
    </Group>
  );
}

/** One routine: its time (saved when the field is left) and an on/off switch. */
function RoutineRow({ routine: r, busy, onChange }: { routine: Routine; busy: string; onChange: (next: { enabled?: boolean; time?: string }) => void }) {
  const [time, setTime] = useState(r.time);
  useEffect(() => setTime(r.time), [r.time]);
  const commit = () => {
    if (time && time !== r.time) onChange({ time });
  };
  return (
    <li className={`py-3 ${busy === r.id ? "opacity-60" : ""}`}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-callout text-fg">{r.title}</p>
          <p className="mt-0.5 text-caption text-fg-3">{r.about}</p>
        </div>
        <Switch label={`${r.title} ${r.enabled ? "on" : "off"}`} checked={r.enabled} disabled={!!busy} onChange={(on) => onChange({ enabled: on })} />
      </div>
      <div className={`mt-2 flex items-center gap-2 ${r.enabled ? "" : "opacity-50"}`}>
        {r.time ? (
          <>
            <label className="sr-only" htmlFor={`routine-${r.id}`}>
              {r.title} time
            </label>
            <input
              id={`routine-${r.id}`}
              type="time"
              value={time}
              disabled={!!busy}
              onChange={(e) => setTime(e.target.value)}
              onBlur={commit}
              onKeyDown={(e) => e.key === "Enter" && commit()}
              className="min-h-9 w-32 rounded-ctl border border-line-2 bg-canvas px-2 text-callout text-fg outline-hidden focus:border-line-3 disabled:opacity-60"
            />
          </>
        ) : null}
        <span className="text-caption text-fg-3">{r.days}</span>
      </div>
    </li>
  );
}

/** The Second Brain's scheduled routines: each on or off, at the time the owner picks. */
function RoutineRows() {
  const assistant = useAssistantName();
  const [items, setItems] = useState<Routine[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  useEffect(() => {
    secondBrain
      .routines()
      .then((r) => (r.ok ? setItems(r.routines) : setError(r.error || "Couldn't read the routines.")))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Couldn't read the routines."));
  }, []);
  async function change(id: string, next: { enabled?: boolean; time?: string }) {
    setBusy(id);
    setError("");
    try {
      const res = await secondBrain.setRoutine(id, next);
      if (!res.ok) throw new Error(res.error || "That didn't save.");
      setItems(res.routines);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That didn't save.");
    } finally {
      setBusy("");
    }
  }
  if (!items && !error) return <Row label="Routines" hint="Reading…" />;
  return (
    <div className="px-3.5 py-3">
      <p className="text-body text-fg">Routines</p>
      <p className="mt-0.5 text-caption text-fg-3">{assistant} looks after the Second Brain on a schedule and tells you what changed.</p>
      {error ? (
        <p role="alert" className="mt-2 text-caption text-danger">
          {error}
        </p>
      ) : null}
      <ul className="mt-2 divide-y divide-(--line-1)">
        {(items || []).map((r) => (
          <RoutineRow key={r.id} routine={r} busy={busy} onChange={(next) => void change(r.id, next)} />
        ))}
      </ul>
      <button type="button" onClick={() => openTeam("routines")} className="press mt-1 flex min-h-10 items-center gap-1 text-callout font-medium text-accent-text hover:underline">
        All routines, for every bot
        <ChevronRightIcon size={14} />
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ Identity and memory */

function IdentityGroup() {
  const assistant = useAssistantName();
  const [open, setOpen] = useState(false);
  return (
    <Group
      icon={<BotIcon className="size-4" />}
      title={`${assistant}'s identity and memory`}
      hint="SOUL.md (who they are), their own notes, and what they know about you."
      action={
        <button type="button" onClick={() => setOpen((v) => !v)} className="press min-h-9 rounded-full border border-line-2 px-3 text-callout text-fg-2 hover:text-fg">
          {open ? "Close" : "Edit"}
        </button>
      }
    >
      {open ? (
        <div className="px-1 py-2">
          <PersonaEditor profile="chief" name={assistant} />
        </div>
      ) : null}
    </Group>
  );
}

/* ------------------------------------------------------------------ the chief's voice (Hermes) */

function VoiceGroup() {
  const assistant = useAssistantName();
  const [data, setData] = useState<HermesSettings | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const next = await fetchSettings();
      setData(next);
    } catch (err) {
      setData(null);
      setError(err instanceof Error ? err.message : "Could not load Hermes settings");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function apply(body: ApplyBody) {
    setSaving(true);
    setError("");
    try {
      const next = await patchSettings(body);
      setData(next);
      notifyVoiceConfig();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
      throw err;
    } finally {
      setSaving(false);
    }
  }

  const stt = data?.stt;
  const tts = data?.tts;
  const pickerReady = (stt?.providers?.length || 0) > 0 || (tts?.providers?.length || 0) > 0;
  const voiceLabel = tts?.voice_label || (tts?.provider === "elevenlabs" ? "ElevenLabs voice" : tts?.provider === "edge" ? "Edge voice" : "");
  const voicePickable = !!voiceLabel;

  return (
    <Group
      icon={<AudioLinesIcon className="size-4" />}
      title={`${assistant}’s voice`}
      hint={`Add a key here if an engine needs one. It is saved to ${assistant}’s own profile on this PC.`}
      action={
        <button
          type="button"
          aria-label="Refresh"
          title="Refresh from Hermes"
          className="press grid size-9 place-items-center rounded-full text-fg-3 hover:bg-white/6 hover:text-fg disabled:opacity-40"
          disabled={loading || saving}
          onClick={() => void load()}
        >
          <RefreshCwIcon className={`size-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      }
    >
      <div className="space-y-4 p-3">
        <SystemCheckRow />
        {loading && !data ? (
          <div className="space-y-2" role="status" aria-label="Loading Hermes…">
            <div className="h-11 rounded-ctl bg-white/4" />
            <div className="h-11 rounded-ctl bg-white/3" />
            <div className="h-11 rounded-ctl bg-white/2" />
          </div>
        ) : null}
        {!loading && !pickerReady ? (
          <p className="rounded-ctl bg-white/4 px-3 py-2 text-callout text-fg-2">
            Voice picker needs a relaunch of Chief Command Center. Current: {stt?.provider || "local"} /{" "}
            {tts?.provider || "edge"}.
          </p>
        ) : null}
        {pickerReady ? (
          <>
            <ProviderList
              label="Hearing"
              providers={stt?.providers || []}
              current={stt?.provider || "local"}
              saving={saving}
              onSelect={(id) => void apply({ stt: { provider: id } }).catch(() => undefined)}
              onSaveKey={(envKey, apiKey) => apply({ secrets: { [envKey]: apiKey } })}
            />
            {(stt?.models?.length || 0) > 0 ? (
              <Field label="Hearing model">
                <Select
                  value={stt?.model && stt.models?.includes(stt.model) ? stt.model : stt?.models?.[0] || ""}
                  disabled={saving}
                  onChange={(id) => void apply({ stt: { model: id } }).catch(() => undefined)}
                >
                  {(stt?.models || []).map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <ProviderList
              label="Speaking"
              providers={tts?.providers || []}
              current={tts?.provider || "edge"}
              saving={saving}
              onSelect={(id) => void apply({ tts: { provider: id } }).catch(() => undefined)}
              onSaveKey={(envKey, apiKey) => apply({ secrets: { [envKey]: apiKey } })}
            />
            {voicePickable && (tts?.voices?.length || 0) > 0 ? (
              <div className="flex items-end gap-2">
                <div className="min-w-0 flex-1">
                  <Field label={voiceLabel}>
                    <Select
                      value={
                        tts?.voice && tts.voices?.some((v) => v.id === tts.voice) ? tts.voice : tts?.voices?.[0]?.id || ""
                      }
                      disabled={saving}
                      onChange={(id) => void apply({ tts: { voice: id } }).catch(() => undefined)}
                    >
                      <VoiceOptions voices={tts?.voices || []} />
                    </Select>
                  </Field>
                </div>
                <VoicePreview disabled={saving} />
              </div>
            ) : null}
            {!voicePickable ? (
              <p className="text-caption text-fg-3">
                Voice for this engine: <span className="text-fg-2">{tts?.voice || "set in Hermes"}</span>.
              </p>
            ) : null}
          </>
        ) : null}
        {error ? (
          <p role="alert" className="text-callout text-danger">
            {error}
          </p>
        ) : null}
        <p className="text-caption text-fg-3">Linked to Hermes chief profile</p>
      </div>
    </Group>
  );
}

/* ------------------------------------------------------------------ This app */

function AppGroup({ phone }: { phone: boolean }) {
  const assistant = useAssistantName();
  const prefs = useDashboardPrefs(phone);
  const fx = useFxPrefs();
  const fullscreen = useFullscreen();

  return (
    <Group
      icon={<SlidersHorizontalIcon className="size-4" />}
      title="This app"
      hint="Only this device. Other devices keep their own settings."
    >
      <Row label="Interface size" stacked>
        <Segmented<UiScale>
          label="Interface size"
          value={fx.uiScale}
          options={[
            ["compact", "Small"],
            ["default", "Default"],
            ["large", "Large"],
          ]}
          onChange={(uiScale) => updateFx((p) => ({ ...p, uiScale }))}
        />
      </Row>
      <Row label="Chat text size" stacked>
        <Segmented<string>
          label="Chat text size"
          value={String(prefs.fontPx)}
          options={FONT_STEPS.map((n) => [String(n), `${n}`] as [string, string])}
          onChange={(id) => prefs.setFont(Number(id))}
        />
        <p
          className="mt-2.5 rounded-ctl bg-well px-3 py-2 text-fg-2 transition-[font-size] duration-fast"
          style={{ fontSize: prefs.fontPx, lineHeight: 1.45 }}
          aria-hidden
        >
          Morning. Three things need you today.
        </p>
      </Row>
      <Row label="Motion" hint={phone ? "System follows your phone’s remove-animations setting." : "System follows Windows’ animation effects setting."} stacked>
        <Segmented<MotionPref>
          label="Motion"
          value={fx.motion}
          options={[
            ["system", "System"],
            ["full", "Full"],
            ["reduced", "Reduced"],
          ]}
          onChange={(motion) => updateFx((p) => ({ ...p, motion }))}
        />
      </Row>
      <Row label="Ambience" hint={`${assistant}’s glow, the orbit starfield and the chat aurora.`} stacked>
        <Segmented<AmbientPref>
          label="Ambience"
          value={fx.ambient}
          options={[
            ["full", "Full"],
            ["low", "Low"],
            ["off", "Off"],
          ]}
          onChange={(ambient) => updateFx((p) => ({ ...p, ambient }))}
        />
      </Row>
      {phone && fullscreen.supported ? (
        <SwitchRow
          label="Full screen"
          hint="Hides the status and navigation bars. Swipe from an edge or press Back to leave."
          checked={fullscreen.active}
          onChange={() => void toggleFullscreen()}
        />
      ) : null}
      <SwitchRow
        label="Speak replies in this app"
        hint="Off also stops current audio. Use Stop in chat to interrupt without turning speech off."
        checked={prefs.speakOn}
        onChange={(next) => {
          prefs.setSpeak(next);
          if (!next) stopSpeech();
        }}
      />
      <SwitchRow
        label="Stay awake"
        hint="Keeps the screen on during a conversation so voice does not freeze. A reply already playing can finish with the screen off. New replies arrive as a notification."
        checked={prefs.stayAwake}
        onChange={(next) => prefs.setStayAwake(next)}
      />
      <SwitchRow
        label="Compact chat"
        hint={`Hides ${assistant}’s tool calls, system notes, and other background rows. Your messages and the normal replies stay.`}
        checked={prefs.compactChat}
        onChange={(next) => prefs.setCompactChat(next)}
      />
      <SwitchRow
        label="Send photos full size"
        hint={`Off: photos are shrunk to 2048 pixels on this device before they go to ${assistant}, so they send in seconds on mobile data. PNG screenshots stay PNG. On: the original file is sent.`}
        checked={prefs.fullPhotos}
        onChange={(next) => prefs.setFullPhotos(next)}
      />
    </Group>
  );
}

/* ------------------------------------------------------------------ Sound */

function SoundGroup() {
  const assistant = useAssistantName();
  const fx = useFxPrefs();
  const [volume, setVolume] = useState(Math.round(fx.volume * 100));
  useEffect(() => setVolume(Math.round(fx.volume * 100)), [fx.volume]);

  return (
    <Group
      icon={<Volume2Icon className="size-4" />}
      title="Sound"
      hint={`Soft interface sounds, made on the device. Quieter while ${assistant} is speaking.`}
    >
      <SwitchRow
        label="Sounds"
        checked={fx.sound.master}
        onChange={(on) => updateFx((p) => ({ ...p, sound: { ...p.sound, master: on } }))}
      />
      <Row label="Volume" stacked dim={!fx.sound.master}>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={volume}
            aria-label="Sound volume"
            disabled={!fx.sound.master}
            onChange={(e) => {
              const v = Number(e.target.value);
              setVolume(v);
              updateFx((p) => ({ ...p, volume: v / 100 }));
            }}
            onPointerUp={() => previewSound("reply")}
            onKeyUp={() => previewSound("reply")}
            className="fx-range min-w-0 flex-1"
            style={{ ["--fill" as string]: `${volume}%` }}
          />
          <span className="tabular w-9 text-right font-mono text-caption text-fg-3">{volume}</span>
        </div>
      </Row>
      {FX_EVENTS.map((event) => (
        <EventRow key={event} kind="sound" event={event} checked={fx.sound[event]} disabled={!fx.sound.master} />
      ))}
    </Group>
  );
}

/* ------------------------------------------------------------------ Haptics */

function HapticsGroup() {
  const fx = useFxPrefs();
  const [supported, setSupported] = useState(true);
  useEffect(() => setSupported(canVibrate()), []);

  return (
    <Group
      icon={<VibrateIcon className="size-4" />}
      title="Haptics"
      hint={supported ? "Short vibrations on Android. Turning one on plays it once." : "This device can’t vibrate. These switches apply when you open the app on your phone."}
    >
      <SwitchRow
        label="Vibration"
        checked={fx.haptics.master}
        onChange={(on) => updateFx((p) => ({ ...p, haptics: { ...p.haptics, master: on } }))}
      />
      {FX_EVENTS.map((event) => (
        <EventRow key={event} kind="haptics" event={event} checked={fx.haptics[event]} disabled={!fx.haptics.master} />
      ))}
    </Group>
  );
}

function EventRow({ kind, event, checked, disabled }: { kind: "sound" | "haptics"; event: FxEvent; checked: boolean; disabled: boolean }) {
  const assistant = useAssistantName();
  const label = FX_EVENT_LABELS[event].replace("{name}", assistant);
  return (
    <SwitchRow
      label={label}
      ariaLabel={`${label} ${kind === "sound" ? "sound" : "vibration"}`}
      checked={checked}
      disabled={disabled}
      dim={disabled}
      inset
      extra={
        kind === "sound" ? (
          <button
            type="button"
            aria-label={`Preview ${label.toLowerCase()} sound`}
            className="press grid size-9 shrink-0 place-items-center rounded-full text-fg-3 hover:bg-white/6 hover:text-fg disabled:opacity-40"
            disabled={disabled}
            onClick={() => previewSound(event, PREVIEW_VARIANT[event])}
          >
            <PlayIcon className="size-3.5" />
          </button>
        ) : null
      }
      onChange={(on) => {
        updateFx((p) => ({ ...p, [kind]: { ...p[kind], [event]: on } }));
        if (on && kind === "haptics") previewHaptic(event, PREVIEW_VARIANT[event]);
      }}
    />
  );
}

/* ------------------------------------------------------------------ Notifications */

function NotificationsGroup() {
  const assistant = useAssistantName();
  const fx = useFxPrefs();
  const [pushMsg, setPushMsg] = useState("");
  const [pushBusy, setPushBusy] = useState(false);
  const [pushAvailable, setPushAvailable] = useState(false);
  const [device, setDevice] = useState<PushStatus | null>(null);

  useEffect(() => {
    let alive = true;
    void pushCapability().then((result) => {
      if (alive) setPushAvailable(result.available);
    });
    void pushStatus().then((status) => {
      if (alive) setDevice(status);
    });
    return () => {
      alive = false;
    };
  }, []);
  const deviceNote =
    device === "on"
      ? "On for this device."
      : device === "blocked"
        ? "Notifications are blocked for this site. Allow them in the browser's site settings, then enable here."
        : device === "unsupported"
          ? "This browser can't receive phone alerts. On Android, add the app to the home screen from Chrome."
          : "";

  return (
    <Group icon={<BellIcon className="size-4" />} title="Notifications">
      <Row
        label="Phone alerts (Web Push)"
        hint={
          !pushAvailable
            ? "Phone alerts are unavailable on this bridge. Keep the dashboard open to see replies and approvals."
            : deviceNote || "Enable supported background alerts on this device."
        }
        stacked
      >
        <button
          type="button"
          disabled={pushBusy || !pushAvailable || device === "blocked" || device === "unsupported"}
          onClick={() => {
            setPushBusy(true);
            setPushMsg("");
            void enableWebPush()
              .then((r) => setPushMsg(r.ok ? "Push enabled on this device." : r.error || "Failed"))
              .then(() => pushStatus().then(setDevice))
              .finally(() => setPushBusy(false));
          }}
          className="press min-h-11 rounded-full bg-fg px-5 text-callout font-semibold text-canvas disabled:bg-white/10 disabled:text-fg-4"
        >
          {pushBusy ? "Enabling…" : device === "on" ? "Re-register this device" : "Enable notifications"}
        </button>
        {pushMsg ? (
          <p role="status" className="mt-2 text-caption text-fg-2">
            {pushMsg}
          </p>
        ) : null}
      </Row>
      <SwitchRow
        label="Fleet change toasts"
        hint={`A small card when ${assistant} adds or retires a bot.`}
        checked={fx.fleetToasts}
        onChange={(fleetToasts) => updateFx((p) => ({ ...p, fleetToasts }))}
      />
      <SwitchRow
        label={`Nudge when ${assistant} hasn’t followed up`}
        hint={`A card if a specialist finishes and ${assistant} says nothing about it for 3 minutes.`}
        checked={fx.nudges}
        onChange={(nudges) => updateFx((p) => ({ ...p, nudges }))}
      />
      <SwitchRow
        label={`Remind me of ${assistant}’s check-backs`}
        hint={`A card if ${assistant} promises to check back and 20 minutes pass without a word.`}
        checked={fx.promises}
        onChange={(promises) => updateFx((p) => ({ ...p, promises }))}
      />
    </Group>
  );
}

/* ------------------------------------------------------------------ Voice providers */

function ProviderList({
  label,
  providers,
  current,
  saving,
  onSelect,
  onSaveKey,
}: {
  label: string;
  providers: SettingsProvider[];
  current: string;
  saving: boolean;
  onSelect: (id: string) => void;
  onSaveKey: (envKey: string, apiKey: string) => Promise<void>;
}) {
  // A key box opens only when the owner picks a provider that needs one.
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <div>
      <p className="mb-1.5 px-1 text-caption font-medium uppercase tracking-wider text-fg-3">{label}</p>
      <div role="radiogroup" aria-label={label} className="overflow-hidden rounded-ctl border border-line bg-well">
        {providers.map((p, i) => {
          const selected = p.id === current;
          const ready = p.status === "ready" || selected;
          const needsKey = p.status === "needs_keys";
          const open = openId === p.id && needsKey;
          return (
            <div key={p.id} className={i ? "border-t border-line" : ""}>
              <button
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={saving || (!ready && !needsKey)}
                onClick={() => {
                  if (needsKey) {
                    setOpenId(open ? null : p.id);
                    return;
                  }
                  if (!selected) onSelect(p.id);
                }}
                className={`flex min-h-12 w-full items-center gap-3 px-3 text-left transition-colors duration-fast disabled:opacity-45 ${
                  selected ? "bg-white/5" : "hover:bg-white/3"
                }`}
              >
                <span
                  aria-hidden
                  className={`grid size-5 shrink-0 place-items-center rounded-full border transition-colors duration-fast ${
                    selected ? "border-transparent bg-fg text-canvas" : "border-line-3"
                  }`}
                >
                  {selected ? <CheckIcon className="size-3" strokeWidth={3} /> : null}
                </span>
                <span className={`min-w-0 flex-1 truncate text-body ${selected ? "font-medium text-fg" : "text-fg-2"}`}>
                  {p.name}
                </span>
                <StatusChip provider={p} selected={selected} />
              </button>
              {open ? (
                <KeyField
                  provider={p}
                  saving={saving}
                  onSave={async (envKey, apiKey) => {
                    await onSaveKey(envKey, apiKey);
                    setOpenId(null);
                  }}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function StatusChip({ provider, selected }: { provider: SettingsProvider; selected: boolean }) {
  if (selected) return <span className="shrink-0 text-caption font-medium text-fg-2">current</span>;
  if (provider.status === "ready") return <span className="shrink-0 text-caption text-fg-3">ready</span>;
  if (provider.status === "needs_keys") {
    return <span className="shrink-0 rounded-chip bg-warn/15 px-1.5 py-0.5 text-caption text-warn">needs key</span>;
  }
  return (
    <span className="max-w-[45%] shrink-0 truncate text-caption text-fg-3">
      {provider.hint || provider.status.replaceAll("_", " ")}
    </span>
  );
}

function KeyField({
  provider,
  saving,
  onSave,
}: {
  provider: SettingsProvider;
  saving: boolean;
  onSave: (envKey: string, apiKey: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);
  const [localError, setLocalError] = useState("");
  const envKey = provider.env_key || (provider.id === "elevenlabs" ? "ELEVENLABS_API_KEY" : "");

  async function submit() {
    if (!envKey || !value.trim()) return;
    setLocalError("");
    try {
      await onSave(envKey, value.trim());
      setValue("");
      setReveal(false);
    } catch (err) {
      setLocalError(err instanceof Error ? err.message : "Could not save");
    }
  }

  return (
    <div className="space-y-2 border-t border-line bg-black/20 px-3 py-3">
      <p className="text-caption text-fg-3">{provider.hint || "Add this key to the chief’s profile"}</p>
      <div className="flex gap-2">
        <input
          type={reveal ? "text" : "password"}
          value={value}
          autoComplete="off"
          spellCheck={false}
          disabled={saving || !envKey}
          placeholder="API key"
          aria-label={`${provider.name} API key`}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
          className="min-h-11 min-w-0 flex-1 rounded-ctl border border-line-2 bg-canvas px-3 font-mono text-code text-fg outline-hidden focus:border-line-3"
        />
        <button type="button" className="chat-type-btn min-h-11 px-3" disabled={saving} onClick={() => setReveal((v) => !v)}>
          {reveal ? "Hide" : "Show"}
        </button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {provider.key_url ? (
          <a
            href={provider.key_url}
            target="_blank"
            rel="noreferrer"
            className="text-caption text-fg-3 underline-offset-2 hover:text-fg hover:underline"
          >
            Get a key
          </a>
        ) : (
          <span />
        )}
        <button
          type="button"
          className="press min-h-10 rounded-full bg-fg px-4 text-callout font-semibold text-canvas disabled:bg-white/10 disabled:text-fg-4"
          disabled={saving || !envKey || !value.trim()}
          onClick={() => void submit()}
        >
          Save to Hermes (chief)
        </button>
      </div>
      {localError ? <p className="text-caption text-danger">{localError}</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ Primitives */

function SwitchRow({
  label,
  ariaLabel,
  hint,
  checked,
  disabled,
  dim,
  inset,
  extra,
  onChange,
}: {
  label: string;
  ariaLabel?: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  dim?: boolean;
  inset?: boolean;
  extra?: ReactNode;
  onChange: (next: boolean) => void;
}) {
  return (
    <div
      className={`flex min-h-12 items-center gap-2 px-3.5 py-2 transition-opacity duration-fast ${dim ? "opacity-45" : ""} ${
        inset ? "pl-5" : ""
      }`}
    >
      <div className="min-w-0 flex-1">
        <p className={inset ? "text-callout text-fg-2" : "text-body text-fg"}>{label}</p>
        {hint ? <p className="mt-0.5 text-caption text-fg-3">{hint}</p> : null}
      </div>
      {extra}
      <Switch label={ariaLabel || label} checked={checked} disabled={disabled} onChange={onChange} />
    </div>
  );
}

/** A real switch: 44px track, spring thumb, accent when on. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block px-1 text-caption font-medium uppercase tracking-wider text-fg-3">{label}</span>
      {children}
    </label>
  );
}

/** Voice options, grouped when the engine groups them (VoiceStudio: designed vs your saved voices). */
function VoiceOptions({ voices }: { voices: VoiceChoice[] }) {
  const groups: [string, VoiceChoice[]][] = [];
  for (const v of voices) {
    const key = v.group || "";
    const hit = groups.find(([g]) => g === key);
    if (hit) hit[1].push(v);
    else groups.push([key, [v]]);
  }
  const option = (v: VoiceChoice) => (
    <option key={v.id} value={v.id}>
      {v.label}
    </option>
  );
  if (groups.length <= 1) return <>{voices.map(option)}</>;
  return (
    <>
      {groups.map(([g, list]) =>
        g ? (
          <optgroup key={g} label={g}>
            {list.map(option)}
          </optgroup>
        ) : (
          list.map(option)
        ),
      )}
    </>
  );
}

/** One short line, addressed to the owner when their name is known. */
const previewLine = (owner: string) => (owner ? `Hi ${owner}. This is how I'll sound.` : "Hi. This is how I'll sound.");

/** Hear the saved voice: one short line through the chief's real speaking engine. */
function VoicePreview({ disabled }: { disabled?: boolean }) {
  const [state, setState] = useState<"idle" | "loading" | "playing">("idle");
  const audio = useRef<HTMLAudioElement | null>(null);
  useEffect(() => () => audio.current?.pause(), []);
  const play = async () => {
    if (state !== "idle") {
      audio.current?.pause();
      setState("idle");
      return;
    }
    setState("loading");
    try {
      const res = await speakText(previewLine(ownerName()), 30_000);
      const src = res.data_urls?.[0] || res.data_url;
      if (!res.ok || !src) throw new Error(res.error || "No audio");
      stopSpeech();
      const el = new Audio(src);
      audio.current = el;
      el.onended = () => setState("idle");
      el.onerror = () => setState("idle");
      await el.play();
      setState("playing");
    } catch {
      setState("idle");
    }
  };
  return (
    <button
      type="button"
      aria-label={state === "idle" ? "Preview voice" : "Stop preview"}
      title={state === "idle" ? "Preview voice" : "Stop preview"}
      className="press grid size-11 shrink-0 place-items-center rounded-ctl border border-line bg-well text-fg-2 hover:text-fg disabled:opacity-40"
      disabled={disabled}
      onClick={() => void play()}
    >
      {state === "loading" ? (
        <RefreshCwIcon className="size-4 animate-spin" />
      ) : state === "playing" ? (
        <SquareIcon className="size-3.5" />
      ) : (
        <PlayIcon className="size-4" />
      )}
    </button>
  );
}

function Select({
  value,
  disabled,
  onChange,
  children,
}: {
  value: string;
  disabled?: boolean;
  onChange: (id: string) => void;
  children: ReactNode;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="min-h-11 w-full rounded-ctl border border-line bg-well px-3 text-body text-fg outline-hidden focus:border-line-3 disabled:opacity-50"
    >
      {children}
    </select>
  );
}

export { Switch };
