"use client";

import { AnimatePresence, motion } from "motion/react";
import { useRef, useState, type UIEvent } from "react";
import { matches } from "@/lib/palette-match";
import { ChevronLeftIcon, ChevronRightIcon, SearchIcon, XIcon } from "@/components/icons";
import { PhoneSettings } from "@/components/phone/phone-settings";
import { Sheet } from "@/components/ui/sheet";
import { EASE, SPRING } from "@/lib/motion";
import { UsagePage } from "@/components/usage/usage-page";
import type { Person } from "@/lib/types";
import { type SettingsCategory } from "@/lib/settings-nav";
import { AboutGroup } from "@/components/settings/about";
import { BackupGroup, UpdatesGroup } from "@/components/settings/backup";
import { AppGroup, ChiefNameGroup, IdentityGroup } from "@/components/settings/general";
import { ConnectionGroup, ModelsKeysGroup } from "@/components/settings/models";
import { HapticsGroup, NotificationsGroup, SoundGroup } from "@/components/settings/notifications";
import { SecondBrainGroup } from "@/components/settings/second-brain";
import { VoiceGroup } from "@/components/settings/voice";
import { ToolsPage } from "@/components/settings/tools";
import { SETTINGS_PAGES } from "@/components/settings/pages";

export type ApplyBody = {
  stt?: { provider?: string; model?: string; api_key?: string };
  tts?: { provider?: string; voice?: string; api_key?: string };
  secrets?: Record<string, string>;
};

/** App and Hermes voice settings in a sheet (bottom on the phone, side panel on desktop). */
const CATEGORIES = SETTINGS_PAGES;
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
  // Find a page by its name or the words it covers ("microphone" finds Voice); the palette shares the words.
  const [query, setQuery] = useState("");
  const shown = CATEGORIES.filter((c) => matches({ label: c.label, keywords: `${c.keywords} ${c.blurb}`, group: "Settings" }, query));
  const search = (
    <label className="mb-2 flex min-h-10 items-center gap-2 rounded-ctl border border-line-2 bg-well px-2.5 text-callout text-fg-3 focus-within:border-line-3">
      <SearchIcon size={15} className="shrink-0" />
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && shown[0]) {
            e.preventDefault();
            choose(shown[0].id);
          }
        }}
        placeholder="Search settings"
        aria-label="Search settings"
        className="min-w-0 flex-1 bg-transparent text-fg outline-hidden placeholder:text-fg-3"
      />
    </label>
  );
  const nothing = shown.length === 0 ? <p className="px-2.5 py-3 text-callout text-fg-3">No settings match.</p> : null;
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
          <button type="button" onClick={onClose} aria-label="Close settings" className="press grid size-11 place-items-center rounded-full text-fg-2 hover:bg-fill-2 hover:text-fg">
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
              <motion.div key="list" initial={{ x: -30, opacity: 0 }} animate={{ x: 0, opacity: 1, transition: { duration: 0.2, ease: EASE.enter } }} exit={{ x: -30, opacity: 0, transition: { duration: 0.12 } }} className="px-4 pb-8">
                {search}
                {nothing}
                <ul className="divide-y divide-(--line-1)">
                  {shown.map(({ id, label, blurb, Icon }) => (
                    <li key={id}>
                      <button type="button" onClick={() => choose(id)} className="press -mx-1 flex min-h-14 w-[calc(100%+0.5rem)] items-center gap-3 rounded-ctl px-1 py-2.5 text-left hover:bg-fill-1">
                        <span className="grid size-8 shrink-0 place-items-center rounded-ctl bg-fill-2 text-fg-2">
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
                </ul>
              </motion.div>
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
        {search}
        {nothing}
        <ul className="space-y-0.5">
          {shown.map(({ id, label, Icon }) => {
            const on = current === id;
            return (
              <li key={id}>
                <button
                  type="button"
                  aria-current={on ? "page" : undefined}
                  onClick={() => choose(id)}
                  className={`press relative flex min-h-10 w-full items-center gap-3 rounded-ctl px-2.5 text-left text-callout transition-colors ${on ? "text-fg" : "text-fg-2 hover:bg-fill-1 hover:text-fg"}`}
                >
                  {on ? <motion.span layoutId="settings-nav" className="absolute inset-0 rounded-ctl bg-fill-3" transition={SPRING.snappy} /> : null}
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
          <button type="button" onClick={onClose} aria-label="Close settings" className="press -mr-2 grid size-10 place-items-center rounded-full text-fg-2 hover:bg-fill-2 hover:text-fg">
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
      ) : id === "tools" ? (
        <ToolsPage />
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

export const MODE_LABEL: Record<string, string> = { new: "The Second Brain layout", keep: "Your own folders", reorganize: "Being reorganized" };

/** One short line, addressed to the owner when their name is known. */
export const previewLine = (owner: string) => (owner ? `Hi ${owner}. This is how I'll sound.` : "Hi. This is how I'll sound.");
