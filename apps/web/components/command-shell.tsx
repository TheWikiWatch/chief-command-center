"use client";

import dynamic from "next/dynamic";
import { AnimatePresence, motion } from "motion/react";
import { startTransition, useCallback, useEffect, useRef, useState, ViewTransition } from "react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelGroupHandle } from "react-resizable-panels";
import { FxRoot } from "@/components/fx-root";
import { HeaderStatus, StatusSheet } from "@/components/connection-status";
import { ChartColumnIcon, ChevronLeftIcon, ChevronRightIcon } from "@/components/icons";
import { useResourceHealth } from "@/components/resource-status";
import { share } from "@/lib/share";
import { ToastViewport } from "@/components/ui/toasts";
import { EngineBanner } from "@/components/engine-banner";
import { ChiefChat, type ChatSend } from "@/components/chief-chat";
import { PHONE_TABS, PhoneNav, type PhoneTab } from "@/components/phone-nav";
import { OPEN_SETTINGS_EVENT, type SettingsCategory } from "@/lib/settings-nav";
import { UsageStrip } from "@/components/usage/usage-strip";
import { readStripPref, writeStripPref } from "@/lib/usage-client";
import { ThreadSwitcher } from "@/components/chat/thread-switcher";
import { setChatThread } from "@/lib/chat-thread";
import { markSeen, readCurrentThread, writeCurrentThread } from "@/lib/threads-client";
import { SurfaceTabs, type Surface } from "@/components/surface-tabs";
import { useVaultOpenSignal } from "@/lib/vault-client";
import { TodayPane } from "@/components/today-pane";
import { WorkforcePane } from "@/components/workforce-pane";
import { TeamButton } from "@/components/fleet/team-sheet";
import { fetchApprovals, fetchHealth, fetchSnapshot, subscribeBridge } from "@/lib/bridge";
import { liveConnected, liveInterval, liveWake, useLiveConnected } from "@/lib/live";
import { useDashboardPrefs } from "@/lib/dashboard-prefs";
import { SPRING } from "@/lib/motion";
import { fx } from "@/lib/fx";
import { useFleetMoments } from "@/lib/roster-moments";
import { noteFinishedJob } from "@/components/chat/followup-cards";
import { splitTitle } from "@/lib/names";
import { assistantName, setAssistantTitle, useAssistantName } from "@/lib/identity";
import { showToast } from "@/lib/toast-store";
import { LayerScope, useLayer } from "@/lib/overlay-stack";
import { useFullscreenShortcut } from "@/lib/use-fullscreen";
import { usePhoneShell } from "@/lib/use-phone-shell";
import { holdWakeLock, releaseWakeLock } from "@/lib/voice-client";
import { refreshServiceWorker } from "@/lib/web-push";
import { useUnseenFleetFlags } from "@/lib/use-fleet-flags";
import { useAppConfig } from "@/lib/app-config";
import { useNeedsOnboarding } from "@/lib/use-needs-onboarding";
import { UpdateCard, useUpdates } from "@/components/updates/update-card";
import { WhatsNewCard } from "@/components/updates/update-history";
// Listens for Android's install offer from the first moment (Settings → Phone shows it).
import "@/lib/install-prompt";
import { closeNotifications, SHOW_APPROVAL_EVENT, subscribeOpenTarget, takeLaunchTarget, type OpenTarget } from "@/lib/open-target";
import type { ExecApproval, Person, Snapshot } from "@/lib/types";
import { FleetViewSwitch } from "@/components/shell/fleet-view-switch";
import { useOpenedOnce, usePrefetchLater } from "@/components/shell/loading";
import { FLEET_VIEW_KEY, FleetView, PHONE_TAB_KEY, STORAGE_KEY, SURFACE_KEY, loadChief, loadPhoneTab, loadSplit, loadSurface, rememberChief } from "@/components/shell/persisted";
import type { PaletteCommand } from "@/components/command-palette";
import { ShortcutList } from "@/components/shortcut-list";
import { Sheet } from "@/components/ui/sheet";
import { AudioLinesIcon, BookOpenIcon, BotIcon, FileTextIcon, HashIcon, ListChecksIcon, MessageCircleIcon, OrbitIcon, PlusIcon, RefreshCwIcon, SettingsIcon, UsersIcon, WifiIcon, ZapIcon } from "@/components/icons";
import { focusComposer, isTyping, openVoiceMode, setDraft } from "@/lib/app-events";
import { matchShortcut } from "@/lib/shortcuts";
import { openSettings as openSettingsAt, openTeam } from "@/lib/settings-nav";
import { threadsApi, type ChatThread } from "@/lib/threads-client";
import { desktop } from "@/lib/desktop";
import { openInVault, vaultSearch } from "@/lib/vault-client";
import { toggleFullscreen } from "@/lib/use-fullscreen";
import { SETTINGS_PAGES } from "@/components/settings/pages";

// Loaded the first time they are needed, not with the first screen (each is its own chunk).
const SettingsPanel = dynamic(() => import("@/components/settings-panel").then((m) => m.SettingsPanel), { ssr: false });
const VaultPane = dynamic(() => import("@/components/vault-pane").then((m) => m.VaultPane), { ssr: false });
const FleetHealth = dynamic(() => import("@/components/fleet-health").then((m) => m.FleetHealth), { ssr: false });
const LookDrawer = dynamic(() => import("@/components/look-drawer").then((m) => m.LookDrawer), { ssr: false });
// Loaded on the first Ctrl+K (and fetched in idle time after the first screen).
const CommandPalette = dynamic(() => import("@/components/command-palette").then((m) => m.CommandPalette), { ssr: false });
const SecondBrainSheet = dynamic(() => import("@/components/second-brain/sheet").then((m) => m.SecondBrainSheet), { ssr: false });
const Onboarding = dynamic(() => import("@/components/onboarding/onboarding").then((m) => m.Onboarding), { ssr: false });

const EMPTY_ROSTER: Person[] = [];
const HEALTH_FAILS = 3;
const SNAP_FRESH_MS = 8000;

/** The palette's Vault results: notes matching the query (opening one brings the Vault into view). */
async function searchVaultNotes(query: string, signal: AbortSignal): Promise<PaletteCommand[]> {
  const { hits } = await vaultSearch(query, signal);
  return hits.slice(0, 6).map((hit) => ({ id: `vault:${hit.path}`, label: hit.name, group: "Vault", icon: <FileTextIcon size={17} />, keywords: hit.path, run: () => openInVault(hit.path) }));
}

export function CommandShell() {
  const assistant = useAssistantName();
  const phone = usePhoneShell();
  usePrefetchLater();
  const prefs = useDashboardPrefs(phone);
  useFullscreenShortcut(!phone);
  // With the live channel up, the snapshot refreshes on changes and every 30 s: "stale" means something else then.
  const live = useLiveConnected();
  const snapshotHealth = useResourceHealth("Fleet", live ? 45_000 : 5_000);
  // Approvals arrive with the chat's transcript on bridges that long-poll; the own poll is then a slow fallback.
  const [approvalsViaChat, setApprovalsViaChat] = useState(false);
  const approvalsViaChatAt = useRef(0);
  const approvalHealth = useResourceHealth("Approvals", approvalsViaChat || live ? 60_000 : 8_000);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(true);
  const onboarding = useNeedsOnboarding(connected);
  const [authFailed, setAuthFailed] = useState(false);
  const [leftSize, setLeftSize] = useState(60);
  const [looking, setLooking] = useState<Person | null>(null);
  const [lookEl, setLookEl] = useState<HTMLElement | null>(null);
  const [chiefThinking, setChiefThinking] = useState(false);
  const [approval, setApproval] = useState<ExecApproval | null>(null);
  const dismissedApproval = useRef<string | null>(null);
  const approvalResolved = useCallback((requestId: string) => {
    dismissedApproval.current = requestId;
    setApproval(current => current?.requestId === requestId ? null : current);
  }, []);
  const approvalFromChat = useCallback((next: ExecApproval | null) => {
    approvalsViaChatAt.current = Date.now();
    setApprovalsViaChat(true);
    if (next?.requestId !== dismissedApproval.current) setApproval((prev) => share(prev, next));
    approvalHealth.success();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [surface, setSurface] = useState<Surface>("today");
  const [phoneTab, setPhoneTab] = useState<PhoneTab>("chat");
  const appConfig = useAppConfig();
  const fleetHealthOn = appConfig.features.fleetHealth;
  const [savedFleetView, setFleetView] = useState<FleetView>("crew");
  // Fleet Health is an optional connector; without it the fleet surface is the crew only.
  const fleetView: FleetView = fleetHealthOn ? savedFleetView : "crew";
  const fleetFlags = useUnseenFleetFlags(fleetHealthOn);
  useEffect(() => {
    try {
      if (localStorage.getItem(FLEET_VIEW_KEY) === "health") setFleetView("health");
    } catch {
      /* ignore */
    }
  }, []);
  const changeFleetView = (next: FleetView) => {
    setFleetView(next);
    try {
      localStorage.setItem(FLEET_VIEW_KEY, next);
    } catch {
      /* ignore */
    }
  };
  const chatSender = useRef<ChatSend | null>(null);
  const registerSender = useCallback((send: ChatSend | null) => { chatSender.current = send; }, []);
  // The chat's thread (separate conversations with the chief), remembered on this device. The chat remounts
  // per thread; `fresh` bumps after a fresh start so the thread reloads.
  const [thread, setThread] = useState("main");
  const [fresh, setFresh] = useState(0);
  const changeThread = useCallback((id: string) => {
    setChatThread(id);
    writeCurrentThread(id);
    markSeen(id);
    setThread(id);
  }, []);
  useEffect(() => changeThread(readCurrentThread()), [changeThread]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsMounted = useOpenedOnce(settingsOpen);
  const [settingsCategory, setSettingsCategory] = useState<SettingsCategory | null>(null);
  useEffect(() => {
    const open = (e: Event) => {
      setSettingsCategory((e as CustomEvent<{ category?: SettingsCategory }>).detail?.category ?? null);
      setSettingsOpen(true);
    };
    window.addEventListener(OPEN_SETTINGS_EVENT, open);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, open);
  }, []);
  // The usage strip under the galaxy: on or off per device.
  const [usageStrip, setUsageStrip] = useState(false);
  useEffect(() => setUsageStrip(readStripPref()), []);
  const toggleUsageStrip = () =>
    setUsageStrip((on) => {
      writeStripPref(!on);
      return !on;
    });
  const [secondBrainOpen, setSecondBrainOpen] = useState(false);
  const secondBrainMounted = useOpenedOnce(secondBrainOpen);
  const [updateLater, setUpdateLater] = useState(false);
  // A newer version on offer (even after Later) outranks "What's new" for the running one: one card at a time.
  const { state: updateState } = useUpdates();
  const offeredVersion = updateState && "release" in updateState && updateState.release && updateState.status !== "error" ? updateState.release.version : "";
  const [statusOpen, setStatusOpen] = useState(false);
  const [lastChief, setLastChief] = useState<Person | null>(null);
  useEffect(() => setLastChief(loadChief()), []);
  useEffect(() => void refreshServiceWorker(), []);
  const [tabDir, setTabDir] = useState(0);
  const groupRef = useRef<ImperativePanelGroupHandle>(null);
  const persistLayout = useRef(false);
  const approvalRef = useRef(false);
  const thinkingRef = useRef(false);

  useEffect(() => {
    if (prefs.stayAwake) void holdWakeLock("stay");
    else void releaseWakeLock("stay");
  }, [prefs.stayAwake]);
  const failStreak = useRef(0);
  const readyAt = useRef(0);
  const lastSnapAt = useRef(0);
  const pingInFlight = useRef(false);
  const authFailedRef = useRef(false);

  const applyDisconnect = useCallback(() => {
    if (authFailedRef.current) {
      setConnected(true);
      return;
    }
    const snapStale = Date.now() - lastSnapAt.current >= SNAP_FRESH_MS;
    if (failStreak.current >= HEALTH_FAILS && snapStale && Date.now() >= readyAt.current) {
      setConnected(false);
    }
  }, []);

  const ping = useCallback(async (signal: AbortSignal) => {
    if (pingInFlight.current) return;
    pingInFlight.current = true;
    try {
      const health = await fetchHealth(signal);
      if (signal.aborted) return;
      if (health.ok) {
        failStreak.current = 0;
        authFailedRef.current = false;
        setAuthFailed(false);
        setConnected(true);
        return;
      }
      if (health.status === 401) {
        authFailedRef.current = true;
        setAuthFailed(true);
        setConnected(true);
        return;
      }
      failStreak.current += 1;
      applyDisconnect();
    } finally {
      pingInFlight.current = false;
    }
  }, [applyDisconnect]);

  const markFresh = useRef<(roster: Snapshot["roster"]) => void>(() => {});
  const refresh = useCallback(async (signal: AbortSignal) => {
    try {
      const data = await fetchSnapshot(signal);
      if (signal.aborted) return;
      snapshotHealth.success();
      lastSnapAt.current = Date.now();
      markFresh.current(data.roster);
      setSnapshot((prev) => share(prev, data));
      const chief = data.roster.find((p) => p.isChief);
      if (chief) {
        rememberChief(chief);
        setAssistantTitle(chief.name);
      }

      // Keep a retired bot's drawer open long enough to say so (VISUAL-OVERHAUL §12).
      setLooking((cur) => (cur ? data.roster.find((p) => p.id === cur.id) || cur : null));
      setConnected(true);
    } catch (error) {
      if (!signal.aborted) snapshotHealth.failure(error);
      /* snapshot miss alone does not raise the reconnect banner */
    }
  }, [snapshotHealth]);

  useEffect(() => {
    readyAt.current = Date.now() + 4000;
  }, []);

  // Outage signature (VISUAL-OVERHAUL §3.2): the shell dims while the chief is unreachable; recovery says so.
  const wasOffline = useRef(false);
  useEffect(() => {
    if (!connected && !authFailed) {
      if (!wasOffline.current) fx("connection", "lost");
      wasOffline.current = true;
      return;
    }
    if (connected && wasOffline.current) {
      wasOffline.current = false;
      fx("connection", "back");
      showToast({ id: "connection", title: "Back online", body: `${assistantName()}'s gateway is answering again`, tone: "ok", icon: "wifi" });
    }
  }, [connected, authFailed]);

  // With the live channel up, the bridge says when anything changes: the ping only confirms the link now and
  // then, and the snapshot and approvals refresh on each change (lib/live.ts). Without it, the old rates.
  useEffect(() => {
    return subscribeBridge(ping, () => liveInterval(2500, 15_000), { wake: liveWake });
  }, [ping]);

  useEffect(() => {
    approvalRef.current = !!approval;
    thinkingRef.current = chiefThinking;
  }, [approval, chiefThinking]);

  useEffect(() => {
    // Rings and beams don't need sub-second updates; the chief's replies and approvals come with the chat.
    return subscribeBridge(refresh, () => liveInterval(2500, 30_000), { wake: liveWake });
  }, [refresh]);

  useEffect(() => subscribeBridge(async (signal) => {
    try {
      const data = await fetchApprovals(signal);
      if (signal.aborted) return;
      if (data.approval?.requestId !== dismissedApproval.current) setApproval((prev) => share(prev, data.approval ?? null));
      approvalHealth.success();
    } catch (error) { if (!signal.aborted) approvalHealth.failure(error); }
  }, () => (Date.now() - approvalsViaChatAt.current < 60_000 ? 30_000 : liveConnected() ? 30_000 : approvalRef.current || thinkingRef.current ? 800 : 4000), { wake: liveWake }), [approvalHealth]);

  useEffect(() => {
    const n = loadSplit();
    setLeftSize(n);
    setSurface(loadSurface());
    setPhoneTab(loadPhoneTab());
    const id = window.requestAnimationFrame(() => {
      groupRef.current?.setLayout([n, 100 - n]);
      persistLayout.current = true;
    });
    return () => window.cancelAnimationFrame(id);
  }, []);

  function changeSurface(next: Surface) {
    // A transition, so the desktop's <ViewTransition> animates the swap (globals.css "surface-in").
    startTransition(() => setSurface(next));
    if (next !== "fleet") setLooking(null);
    try {
      localStorage.setItem(SURFACE_KEY, next);
    } catch {
      /* ignore */
    }
  }

  function changePhoneTab(next: PhoneTab) {
    const order = PHONE_TABS.map((t) => t.id);
    setTabDir(Math.sign(order.indexOf(next) - order.indexOf(phoneTab)));
    setPhoneTab(next);
    if (next !== "fleet") setLooking(null);
    if (next === "today" || next === "fleet" || next === "vault") changeSurface(next);
    try {
      localStorage.setItem(PHONE_TAB_KEY, next);
    } catch {
      /* ignore */
    }
  }

  // On the phone, Back from Today, Fleet or Vault returns to Chat instead of leaving the app.
  useLayer(phone && phoneTab !== "chat", () => changePhoneTab("chat"));

  // A vault link tapped anywhere (The chief's messages, a note) brings the Vault into view.
  const vaultSignal = useVaultOpenSignal();
  useEffect(() => {
    if (!vaultSignal) return;
    if (phone) changePhoneTab("vault");
    else changeSurface("vault");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vaultSignal]);

  // A tapped notification says where to go (lib/open-target.ts): `?open=` on a cold start, a worker
  // message when the app is already open. changePhoneTab also moves the desktop surface.
  const goTo = useRef<(target: OpenTarget) => void>(() => {});
  goTo.current = (target) => {
    changePhoneTab(target.tab as PhoneTab);
    if (target.thread) changeThread(target.thread);
    if (target.view === "health") changeFleetView("health");
    if (target.approval) window.dispatchEvent(new CustomEvent(SHOW_APPROVAL_EVENT, { detail: target.approval }));
  };
  useEffect(() => {
    const launch = takeLaunchTarget();
    if (launch) goTo.current(launch);
    return subscribeOpenTarget((target) => goTo.current(target));
  }, []);
  // Once the app is on screen, its reply and approval notifications on this device are old news.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void closeNotifications();
    };
    onVisible();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  async function sendFromToday(text: string) {
    if (!chatSender.current) throw new Error("Chat is loading. Your task has been kept.");
    await chatSender.current(text);
    if (phone) changePhoneTab("chat");
  }

  function snapTo(next: number) {
    groupRef.current?.setLayout([next, 100 - next]);
    setLeftSize(next);
    try {
      localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      /* ignore */
    }
  }

  const mode = phone ? "rail" : leftSize >= 52 ? "orbit" : "rail";
  const people = snapshot?.roster || EMPTY_ROSTER;
  const moments = useFleetMoments(people, connected, (e) => {
    if (e.kind === "minted") fx("fleet", "minted");
    else if (e.kind === "retired") fx("fleet", "retired");
    else if (e.kind === "finished") noteFinishedJob(e.person, e.previous?.jobTitle || "", splitTitle(e.person.name).name);
  });
  markFresh.current = moments.markFresh;
  // While the gateway is down there is no roster; show the last-known the chief (asleep) instead of nothing.
  const chief = people.find((p) => p.isChief) ?? (connected ? undefined : lastChief ?? undefined);
  const specialists = people.filter((p) => !p.isChief);
  const workingCount = specialists.filter((p) => p.ring === "working").length;
  const openStatus = () => setStatusOpen(true);

  // The command palette (Ctrl+K) and the keyboard map (lib/shortcuts.ts).
  const [paletteOpen, setPaletteOpen] = useState(false);
  const paletteMounted = useOpenedOnce(paletteOpen);
  // The threads, fresh each time the palette opens.
  const [paletteThreads, setPaletteThreads] = useState<ChatThread[]>([]);
  useEffect(() => {
    if (!paletteOpen) return;
    let alive = true;
    void threadsApi.list().then(
      (res) => alive && res.ok && setPaletteThreads(res.threads.filter((t) => !t.archived)),
      () => undefined,
    );
    return () => {
      alive = false;
    };
  }, [paletteOpen]);
  const [helpOpen, setHelpOpen] = useState(false);
  const goToPlace = (target: Surface | "chat") => {
    if (phone) changePhoneTab(target);
    else if (target !== "chat") changeSurface(target);
    if (target === "chat") window.setTimeout(focusComposer, 0);
  };
  // Text for the message box, never sent on its own (the palette's "Ask …", the Fleet's suggestions).
  const askChief = (text: string) => {
    goToPlace("chat");
    window.setTimeout(() => setDraft(text), 50);
  };
  const openVoice = () => {
    goToPlace("chat");
    window.setTimeout(openVoiceMode, 50);
  };
  const newThread = async () => {
    const res = await threadsApi.create().catch(() => null);
    if (res?.ok && res.thread) {
      changeThread(res.thread.id);
      if (phone) changePhoneTab("chat");
      window.setTimeout(focusComposer, 50);
    } else showToast({ id: "thread", title: "Couldn't start a thread", body: res?.error || `${assistantName()} isn't answering.`, tone: "warn", icon: "alert" });
  };
  // The taskbar's jump list and the tray (desktop app): New thread, Voice mode, Today.
  const desktopAction = useRef<(action: string) => void>(() => {});
  useEffect(() => {
    desktopAction.current = (action) => {
      if (action === "new-thread") void newThread();
      else if (action === "voice") openVoice();
      else if (action === "today") goToPlace("today");
    };
  });
  useEffect(() => desktop()?.onAction?.((action) => desktopAction.current(action)), []);
  const commands: PaletteCommand[] = [
    { id: "chat", label: `Chat with ${assistant}`, group: "Go to", icon: <MessageCircleIcon size={17} />, keywords: "message talk write", shortcut: "composer", run: () => goToPlace("chat") },
    { id: "fleet", label: "Fleet", group: "Go to", icon: <OrbitIcon size={17} />, keywords: "bots team orbit", shortcut: phone ? undefined : "surface1", run: () => { goToPlace("fleet"); changeFleetView("crew"); } },
    { id: "today", label: "Today", group: "Go to", icon: <ListChecksIcon size={17} />, keywords: "tasks todo", shortcut: phone ? undefined : "surface2", run: () => goToPlace("today") },
    { id: "vault", label: "Vault", group: "Go to", icon: <BookOpenIcon size={17} />, keywords: "notes second brain files", shortcut: phone ? undefined : "surface3", run: () => goToPlace("vault") },
    ...(fleetHealthOn ? [{ id: "health", label: "Fleet Health", group: "Go to" as const, icon: <ChartColumnIcon size={17} />, keywords: "skills learning flags", run: () => { goToPlace("fleet"); changeFleetView("health"); } }] : []),
    { id: "team", label: "Team & Routines", group: "Go to", icon: <UsersIcon size={17} />, keywords: "bots routines schedule cron", run: () => openTeam("team") },
    { id: "new-thread", label: "New thread", group: "Chat", icon: <PlusIcon size={17} />, keywords: "conversation", shortcut: "newThread", run: () => void newThread() },
    { id: "voice", label: "Voice mode", group: "Chat", icon: <AudioLinesIcon size={17} />, keywords: "talk speak microphone", shortcut: "voice", run: openVoice },
    { id: "status", label: "Connection status", group: "App", icon: <WifiIcon size={17} />, keywords: "health gateway online", run: openStatus },
    { id: "fullscreen", label: "Full screen", group: "App", icon: <ZapIcon size={17} />, keywords: "maximize f11", run: () => void toggleFullscreen() },
    { id: "shortcuts", label: "Keyboard shortcuts", group: "App", icon: <HashIcon size={17} />, keywords: "keys help", shortcut: "help", run: () => setHelpOpen(true) },
    { id: "settings", label: "Settings", group: "Settings", icon: <SettingsIcon size={17} />, keywords: "preferences options", shortcut: "settings", run: () => openSettingsAt() },
    ...SETTINGS_PAGES.map((page) => ({ id: `settings-${page.id}`, label: `Settings: ${page.label}`, group: "Settings" as const, icon: page.icon, keywords: page.keywords, run: () => openSettingsAt(page.id) })),
    ...(desktop()?.updates ? [{ id: "updates", label: "Check for updates", group: "App" as const, icon: <RefreshCwIcon size={17} />, keywords: "new version upgrade", run: () => { openSettingsAt("backup"); void desktop()?.updates?.check(); } }] : []),
    ...(desktop()?.openLogs ? [{ id: "logs", label: "Open logs folder", group: "App" as const, icon: <FileTextIcon size={17} />, keywords: "debug diagnostics troubleshoot", run: () => void desktop()?.openLogs?.() }] : []),
    ...paletteThreads.map((t) => ({ id: `thread:${t.id}`, label: t.title || "Untitled thread", group: "Threads" as const, icon: <MessageCircleIcon size={17} />, keywords: "thread conversation", run: () => { changeThread(t.id); goToPlace("chat"); } })),
    ...people.filter((p) => !p.isChief).map((p) => ({ id: `bot:${p.id}`, label: splitTitle(p.name).name || p.name, group: "Fleet" as const, icon: <BotIcon size={17} />, keywords: `${splitTitle(p.name).role} bot specialist ${p.jobTitle}`, run: () => { goToPlace("fleet"); setLooking(p); } })),
  ];
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (onboarding.needed) return;
      const id = matchShortcut(e, isTyping(e.target));
      if (!id) return;
      e.preventDefault();
      if (id === "palette") setPaletteOpen((v) => !v);
      else if (id === "settings") openSettingsAt();
      else if (id === "composer") goToPlace("chat");
      else if (id === "help") setHelpOpen(true);
      else if (id === "newThread") void newThread();
      else if (id === "voice") openVoice();
      else if (id === "surface1") phone ? changePhoneTab("chat") : goToPlace("fleet");
      else if (id === "surface2") goToPlace(phone ? "today" : "today");
      else if (id === "surface3") goToPlace(phone ? "fleet" : "vault");
      else if (id === "surface4") goToPlace("vault");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const openSettings = () => {
    setSettingsCategory(null);
    setSettingsOpen(true);
  };
  const headerStatus = (
    <HeaderStatus connected={connected} authFailed={authFailed} onOpenStatus={openStatus} onOpenSettings={openSettings} />
  );
  const chat = (
    <ChiefChat
      key={`${thread}:${fresh}`}
      threadSwitcher={<ThreadSwitcher current={thread} onChange={changeThread} onFresh={() => setFresh((n) => n + 1)} phone={phone} />}
      chief={chief}
      people={people}
      lookAtEl={lookEl}
      connected={connected}
      authFailed={authFailed}
      approval={approval}
      onSendReady={registerSender}
      compact={phone}
      onThinkingChange={setChiefThinking}
      onApprovalResolved={approvalResolved}
      onApprovalUpdate={approvalFromChat}
      onOpenSettings={openSettings}
      onOpenStatus={openStatus}
    />
  );
  const today = (
    <TodayPane
      surface={surface}
      onSurface={changeSurface}
      onSendToChief={sendFromToday}
      hideTabs={phone}
      trailing={phone ? headerStatus : null}
      onSetUpSecondBrain={() => setSecondBrainOpen(true)}
    />
  );
  const vault = (
    <VaultPane phone={phone} surface={surface} onSurface={changeSurface} trailing={phone ? headerStatus : null} onSetUpSecondBrain={() => setSecondBrainOpen(true)} />
  );
  const viewSwitch = fleetHealthOn ? <FleetViewSwitch view={fleetView} onChange={changeFleetView} flags={fleetView === "health" ? 0 : fleetFlags} /> : null;
  const usageToggle = (
    <button
      type="button"
      onClick={toggleUsageStrip}
      aria-pressed={usageStrip}
      aria-label={usageStrip ? "Hide usage" : "Show usage"}
      title={usageStrip ? "Hide usage" : "Show usage"}
      className={`press grid size-11 shrink-0 place-items-center rounded-full ${
        phone ? "" : "border border-line-2 bg-pane/90 shadow-e3 backdrop-blur-sm hover:border-line-3"
      } ${usageStrip ? "text-fg" : "text-fg-3 hover:text-fg"}`}
    >
      <ChartColumnIcon size={phone ? 19 : 17} />
    </button>
  );
  const fleet = (
    <>
      {phone ? (
        <header className="app-drag titlebar-clear-phone relative z-20 flex shrink-0 items-center gap-3 border-b border-line px-4 py-2">
          {/* The tab bar already says Fleet; the header keeps its controls on one line at phone width. */}
          <h1 className="sr-only">
            Fleet: {specialists.length} {specialists.length === 1 ? "specialist" : "specialists"}
            {workingCount ? `, ${workingCount} working` : ""}
          </h1>
          {viewSwitch}
          <div className="flex-1" />
          {fleetView === "health" ? null : usageToggle}
          <TeamButton phone people={people} onAskChief={sendFromToday} />
          {headerStatus}
        </header>
      ) : (
        <>
          {/* No header over the orbit: this strip is where the window is dragged from. */}
          <div className="app-drag absolute inset-x-0 top-0 z-10 h-15" aria-hidden />
          <div className="absolute left-3 top-3 z-20">
            <SurfaceTabs surface={surface} onChange={changeSurface} />
          </div>
          <div className="absolute right-3 top-3 z-20 flex items-center gap-2">
            {viewSwitch}
            {fleetView === "health" ? null : usageToggle}
            <TeamButton phone={false} people={people} onAskChief={sendFromToday} />
          </div>
        </>
      )}
      {fleetView === "health" ? (
        <div className={`relative min-h-0 flex-1 overflow-y-auto overscroll-contain bg-pane ${phone ? "" : "pt-14"}`}>
          <FleetHealth people={people} phone={phone} onSendToChief={sendFromToday} />
        </div>
      ) : (
      <div className="relative min-h-0 flex-1">
        <WorkforcePane
          people={people}
          mode={mode}
          onOpen={setLooking}
          onLookTarget={setLookEl}
          chiefThinking={connected && chiefThinking}
          moments={moments}
          connected={connected}
          phone={phone}
          onAsk={askChief}
        />
        <AnimatePresence>
          {usageStrip ? (
            <div key="usage" className="absolute inset-x-3 bottom-3 z-20">
              <UsageStrip
                people={people}
                onOpen={() => {
                  setSettingsCategory("usage");
                  setSettingsOpen(true);
                }}
              />
            </div>
          ) : null}
        </AnimatePresence>
        {looking ? (
          <LookDrawer
            key={looking.id}
            person={looking}
            onClose={() => setLooking(null)}
            full={phone}
            retired={people.length > 0 && !people.some((p) => p.id === looking.id)}
          />
        ) : null}
      </div>
      )}
    </>
  );

  const offline = !connected && !authFailed;
  const dim = `transition-[filter] duration-600 ease-enter ${offline ? "filter-[saturate(.55)_brightness(.85)]" : ""}`;
  const sheets = (
    <>
      {onboarding.needed ? <Onboarding onLater={onboarding.later} onFinished={onboarding.finish} onAskChief={sendFromToday} /> : null}
      {settingsMounted ? <SettingsPanel
        open={settingsOpen}
        phone={phone}
        onClose={() => setSettingsOpen(false)}
        onAskChief={sendFromToday}
        chief={chief}
        category={settingsCategory}
      /> : null}
      {secondBrainMounted ? <SecondBrainSheet open={secondBrainOpen} phone={phone} onClose={() => setSecondBrainOpen(false)} onAskChief={sendFromToday} /> : null}
      {onboarding.needed ? null : (
        // Top right, under the headers: clear of the message box and the tab bar.
        <div className="fixed right-4 top-16 z-50 w-[min(24rem,calc(100vw-2rem))] space-y-2">
          {updateLater ? null : <UpdateCard compact onLater={() => setUpdateLater(true)} />}
          <WhatsNewCard newer={offeredVersion} />
        </div>
      )}
      <StatusSheet open={statusOpen} onClose={() => setStatusOpen(false)} connected={connected} authFailed={authFailed} phone={phone} deepseek={chief?.provider === "deepseek"} />
      {paletteMounted ? <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} assistant={assistant} onAsk={askChief} search={searchVaultNotes} /> : null}
      <AnimatePresence>
        {helpOpen ? (
          <Sheet open={helpOpen} onClose={() => setHelpOpen(false)} side={phone ? "bottom" : "right"} title="Keyboard shortcuts" subtitle="Single keys work when you're not typing in a box.">
            <div className="px-4 pb-6">
              <ShortcutList phone={phone} />
            </div>
          </Sheet>
        ) : null}
      </AnimatePresence>
      <ToastViewport />
      <EngineBanner />
    </>
  );

  if (phone) {
    const panel = (id: PhoneTab, extra = "") =>
      phoneTab === id ? `h-full ${tabDir > 0 ? "tab-in-r" : tabDir < 0 ? "tab-in-l" : ""} ${extra}` : "hidden";
    return (
      <FxRoot>
        <div className="flex h-app flex-col bg-canvas pt-[env(safe-area-inset-top)]">
          <div className={`relative min-h-0 flex-1 overflow-hidden ${dim}`}>
            <div className={panel("chat")}>
              <LayerScope visible={phoneTab === "chat"}>{chat}</LayerScope>
            </div>
            <div className={panel("today")}>
              <LayerScope visible={phoneTab === "today"}>{today}</LayerScope>
            </div>
            <div className={panel("fleet", "relative flex min-h-0 flex-col overflow-hidden")}>
              <LayerScope visible={phoneTab === "fleet"}>{fleet}</LayerScope>
            </div>
            <div className={panel("vault")}>
              <LayerScope visible={phoneTab === "vault"}>{vault}</LayerScope>
            </div>
            <AnimatePresence>
              {approval && phoneTab !== "chat" ? (
                <motion.button
                  key="approval-pill"
                  type="button"
                  className="absolute bottom-3 left-1/2 z-30 flex min-h-11 -translate-x-1/2 items-center gap-2 rounded-full border border-warn/40 bg-raised/95 px-4 text-callout font-medium text-warn shadow-e3"
                  initial={{ opacity: 0, y: 16, scale: 0.94 }}
                  animate={{ opacity: 1, y: 0, scale: 1, transition: SPRING.bouncy }}
                  exit={{ opacity: 0, y: 12, transition: { duration: 0.16 } }}
                  onClick={() => changePhoneTab("chat")}
                  aria-label={`${assistant} needs your approval — open Chat`}
                >
                  <span className="relative flex h-2.5 w-2.5">
                    <span className="absolute inset-0 animate-ping rounded-full bg-warn opacity-70" />
                    <span className="relative h-2.5 w-2.5 rounded-full bg-warn" />
                  </span>
                  Approval needed
                </motion.button>
              ) : null}
            </AnimatePresence>
          </div>
          <PhoneNav approvalPending={!!approval} fleetFlags={fleetFlags} tab={phoneTab} onChange={changePhoneTab} />
        </div>
        {sheets}
      </FxRoot>
    );
  }

  return (
    <FxRoot>
      <div className={`relative flex h-app flex-col bg-canvas ${dim}`}>
        <PanelGroup
          ref={groupRef}
          direction="horizontal"
          className="h-full"
          onLayout={(sizes) => {
            const left = sizes[0] ?? 60;
            setLeftSize(left);
            if (!persistLayout.current) return;
            try {
              localStorage.setItem(STORAGE_KEY, String(left >= 52 ? 60 : 40));
            } catch {
              /* ignore */
            }
          }}
        >
          <Panel defaultSize={60} minSize={32} className="relative flex h-full min-h-0 flex-col overflow-hidden bg-pane">
            <ViewTransition key={surface} enter="surface-in" exit="surface-out">
              <div className="relative flex h-full min-h-0 flex-col">{surface === "today" ? today : surface === "vault" ? vault : fleet}</div>
            </ViewTransition>
          </Panel>
          <PanelResizeHandle
            className="group relative z-20 flex w-3 items-center justify-center bg-transparent"
            aria-label="Drag to switch Orbit and Chat"
            hitAreaMargins={{ coarse: 16, fine: 8 }}
            onDragging={(drag) => {
              if (drag) return;
              const left = groupRef.current?.getLayout()?.[0] ?? 60;
              snapTo(left >= 52 ? 60 : 40);
            }}
          >
            <span className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-line-2 transition-colors duration-fast group-hover:bg-accent/70 group-active:bg-accent" />
            <button
              type="button"
              className="press glass relative z-10 flex h-14 w-5 items-center justify-center rounded-full text-fg-3 transition-colors duration-fast hover:text-fg"
              aria-label={mode === "orbit" ? "Switch to chat-wide rail" : "Switch to orbit"}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => snapTo(leftSize >= 52 ? 40 : 60)}
            >
              {mode === "orbit" ? <ChevronLeftIcon size={14} /> : <ChevronRightIcon size={14} />}
            </button>
          </PanelResizeHandle>
          <Panel defaultSize={40} minSize={32} className="h-full min-h-0">
            {chat}
          </Panel>
        </PanelGroup>
      </div>
      {sheets}
    </FxRoot>
  );
}
