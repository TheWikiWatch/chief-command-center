"use client";

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Panel, PanelGroup, PanelResizeHandle, type ImperativePanelGroupHandle } from "react-resizable-panels";

import { FxRoot } from "@/components/fx-root";
import { HeaderStatus, StatusSheet } from "@/components/connection-status";
import { ChevronLeftIcon, ChevronRightIcon } from "@/components/icons";
import { useResourceHealth } from "@/components/resource-status";
import { share } from "@/lib/share";
import { ToastViewport } from "@/components/ui/toasts";
import { LookDrawer } from "@/components/look-drawer";
import { ChiefChat, type ChatSend } from "@/components/chief-chat";
import { PHONE_TABS, PhoneNav, type PhoneTab } from "@/components/phone-nav";
import { SettingsPanel } from "@/components/settings-panel";
import { SurfaceTabs, type Surface } from "@/components/surface-tabs";
import { VaultPane } from "@/components/vault-pane";
import { useVaultOpenSignal } from "@/lib/vault-client";
import { TodayPane } from "@/components/today-pane";
import { WorkforcePane } from "@/components/workforce-pane";
import { FleetHealth } from "@/components/fleet-health";
import { fetchApprovals, fetchHealth, fetchSnapshot, subscribeBridge } from "@/lib/bridge";
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
import { Onboarding, useNeedsOnboarding } from "@/components/onboarding/onboarding";
import { SecondBrainSheet } from "@/components/second-brain/sheet";
import { UpdateCard } from "@/components/updates/update-card";
import { closeNotifications, SHOW_APPROVAL_EVENT, subscribeOpenTarget, takeLaunchTarget, type OpenTarget } from "@/lib/open-target";
import type { ExecApproval, Person, Snapshot } from "@/lib/types";

const EMPTY_ROSTER: Person[] = [];
const STORAGE_KEY = "chief-split";
const SURFACE_KEY = "chief-surface";
const PHONE_TAB_KEY = "chief-phone-tab";
const FLEET_VIEW_KEY = "chief-fleet-view";
type FleetView = "crew" | "health";
const HEALTH_FAILS = 3;
const SNAP_FRESH_MS = 8000;

export function CommandShell() {
  const assistant = useAssistantName();
  const phone = usePhoneShell();
  const prefs = useDashboardPrefs(phone);
  useFullscreenShortcut(!phone);
  const snapshotHealth = useResourceHealth("Fleet", 5_000);
  // Approvals arrive with the chat's transcript on bridges that long-poll; the own poll is then a slow fallback.
  const [approvalsViaChat, setApprovalsViaChat] = useState(false);
  const approvalsViaChatAt = useRef(0);
  const approvalHealth = useResourceHealth("Approvals", approvalsViaChat ? 60_000 : 8_000);
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [secondBrainOpen, setSecondBrainOpen] = useState(false);
  const [updateLater, setUpdateLater] = useState(false);
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
  }, []);

  useEffect(() => {
    readyAt.current = Date.now() + 4000;
  }, []);

  // Outage signature (VISUAL-OVERHAUL §3.2): the shell dims while Chief is unreachable; recovery says so.
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

  useEffect(() => {
    return subscribeBridge(ping, 2500);
  }, [ping]);

  useEffect(() => {
    approvalRef.current = !!approval;
    thinkingRef.current = chiefThinking;
  }, [approval, chiefThinking]);

  useEffect(() => {
    // Rings and beams don't need sub-second updates; Chief's replies and approvals come with the chat.
    return subscribeBridge(refresh, 2500);
  }, [refresh]);

  useEffect(() => subscribeBridge(async (signal) => {
    try {
      const data = await fetchApprovals(signal);
      if (signal.aborted) return;
      if (data.approval?.requestId !== dismissedApproval.current) setApproval((prev) => share(prev, data.approval ?? null));
      approvalHealth.success();
    } catch (error) { if (!signal.aborted) approvalHealth.failure(error); }
  }, () => (Date.now() - approvalsViaChatAt.current < 60_000 ? 30_000 : approvalRef.current || thinkingRef.current ? 800 : 4000)), []);

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
    setSurface(next);
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

  // A vault link tapped anywhere (Chief's messages, a note) brings the Vault into view.
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
  // While the gateway is down there is no roster; show the last-known Chief (asleep) instead of nothing.
  const chief = people.find((p) => p.isChief) ?? (connected ? undefined : lastChief ?? undefined);
  const specialists = people.filter((p) => !p.isChief);
  const workingCount = specialists.filter((p) => p.ring === "working").length;
  const openStatus = () => setStatusOpen(true);
  const openSettings = () => setSettingsOpen(true);
  const headerStatus = (
    <HeaderStatus connected={connected} authFailed={authFailed} onOpenStatus={openStatus} onOpenSettings={openSettings} />
  );
  const chat = (
    <ChiefChat
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
  const fleet = (
    <>
      {phone ? (
        <header className="relative z-20 flex shrink-0 items-center gap-3 border-b border-line px-4 py-2">
          <div className="min-w-0 flex-1">
            <h1 className="text-headline text-fg">Fleet</h1>
            <p className="truncate text-caption text-fg-3">
              {specialists.length} {specialists.length === 1 ? "specialist" : "specialists"}
              {workingCount ? <span className="text-accent-text"> · {workingCount} working</span> : null}
            </p>
          </div>
          {viewSwitch}
          {headerStatus}
        </header>
      ) : (
        <>
          <div className="absolute left-3 top-3 z-20">
            <SurfaceTabs surface={surface} onChange={changeSurface} />
          </div>
          <div className="absolute right-3 top-3 z-20">{viewSwitch}</div>
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
        />
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
  const dim = `transition-[filter] duration-[600ms] ease-enter ${offline ? "[filter:saturate(.55)_brightness(.85)]" : ""}`;
  const sheets = (
    <>
      {onboarding.needed ? <Onboarding onLater={onboarding.later} onFinished={onboarding.finish} onAskChief={sendFromToday} /> : null}
      <SettingsPanel open={settingsOpen} phone={phone} onClose={() => setSettingsOpen(false)} onAskChief={sendFromToday} />
      <SecondBrainSheet open={secondBrainOpen} phone={phone} onClose={() => setSecondBrainOpen(false)} onAskChief={sendFromToday} />
      {updateLater || onboarding.needed ? null : (
        <div className="fixed bottom-4 right-4 z-50 w-[min(24rem,calc(100vw-2rem))]">
          <UpdateCard compact onLater={() => setUpdateLater(true)} />
        </div>
      )}
      <StatusSheet open={statusOpen} onClose={() => setStatusOpen(false)} connected={connected} authFailed={authFailed} phone={phone} deepseek={chief?.provider === "deepseek"} />
      <ToastViewport />
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
            {surface === "today" ? today : surface === "vault" ? vault : fleet}
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

/** Fleet surface: the crew (orbit / list) or its health (scorecards, learning, runtime, proposals). */
function FleetViewSwitch({ view, onChange, flags = 0 }: { view: FleetView; onChange: (next: FleetView) => void; flags?: number }) {
  return (
    <div className="glass flex shrink-0 rounded-full p-0.5" role="tablist" aria-label="Fleet view">
      {(["crew", "health"] as const).map((id) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={view === id}
          onClick={() => onChange(id)}
          className={`relative min-h-9 rounded-full px-3 text-callout font-medium transition-colors duration-fast ${view === id ? "text-fg" : "text-fg-3 hover:text-fg-2"}`}
        >
          {view === id ? <motion.span layoutId="fleet-view" className="absolute inset-0 rounded-full bg-white/10" transition={SPRING.snappy} /> : null}
          <span className="relative">{id === "crew" ? "Crew" : "Health"}</span>
          {id === "health" && flags ? (
            <span className="relative ml-1.5 inline-grid min-w-[18px] place-items-center rounded-full bg-warn/20 px-1 font-mono text-[11px] leading-[18px] text-warn tabular" aria-label={`${flags} new ${flags === 1 ? "flag" : "flags"}`}>
              {flags}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}

const CHIEF_KEY = "chief-last-chief";

function rememberChief(p: Person) {
  try {
    localStorage.setItem(CHIEF_KEY, JSON.stringify({ ...p, ring: "idle", jobTitle: "" }));
  } catch {
    /* ignore */
  }
}

function loadChief(): Person | null {
  try {
    const raw = localStorage.getItem(CHIEF_KEY);
    const p = raw ? (JSON.parse(raw) as Person) : null;
    return p && typeof p.id === "string" && p.isChief ? p : null;
  } catch {
    return null;
  }
}

function loadSurface(): Surface {
  try {
    const raw = localStorage.getItem(SURFACE_KEY);
    if (raw === "fleet" || raw === "today" || raw === "vault") return raw;
  } catch {
    /* ignore */
  }
  return "today";
}

function loadPhoneTab(): PhoneTab {
  try {
    const raw = localStorage.getItem(PHONE_TAB_KEY);
    if (raw === "chat" || raw === "today" || raw === "fleet" || raw === "vault") return raw;
  } catch {
    /* ignore */
  }
  return "chat";
}

function loadSplit() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const n = raw ? Number(raw) : 60;
    if (n >= 52) return 60;
    if (n > 0) return 40;
  } catch {
    /* ignore */
  }
  return 60;
}
