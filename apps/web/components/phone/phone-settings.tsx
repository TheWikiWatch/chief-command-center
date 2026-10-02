"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";

import { BellIcon, CheckIcon, CircleAlertIcon, CopyIcon, ExternalLinkIcon, LinkIcon, SmartphoneIcon, UsersIcon } from "@/components/icons";
import { QrCode } from "@/components/phone/qr-code";
import { Group, PillButton, Row } from "@/components/ui/settings-group";
import { desktop, type PhoneState } from "@/lib/desktop";
import { useAssistantName } from "@/lib/identity";
import { canPromptInstall, isStandalone, onInstallPromptChange, phonePlatform, promptInstall } from "@/lib/install-prompt";
import { disableWebPush, enableWebPush, pushCapability, pushDeviceCount, pushStatus, sendTestPush, type PushStatus } from "@/lib/web-push";

const LINKS = {
  windows: "https://tailscale.com/download/windows",
  dns: "https://login.tailscale.com/admin/dns",
  play: "https://play.google.com/store/apps/details?id=com.tailscale.ipn",
  appStore: "https://apps.apple.com/app/tailscale/id1470499037",
};

const isLoopback = () => typeof window !== "undefined" && /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(window.location.hostname);

/**
 * Settings → Phone. On the PC (the desktop app): a guided setup that checks each step live and does the
 * Tailscale part itself. On the phone (opened through that address): this phone's home-screen install and
 * alerts. Elsewhere (a development browser on the PC): what to use instead.
 */
export function PhoneSettings() {
  const pc = desktop()?.phone;
  if (pc) return <PcSetup />;
  if (!isLoopback()) return <ThisPhone />;
  return (
    <Group icon={<SmartphoneIcon className="size-4" />} title="Phone access" hint="Set up phone access from the installed desktop app (Settings → Phone). This browser window can't change Tailscale.">
      <Row label="Using the app on your phone" hint="Your PC and phone join a private Tailscale network; the app adds a private https:// address for Chief that only your account can open." />
    </Group>
  );
}

/* ------------------------------------------------------------------ the PC */

type StepStatus = "done" | "todo" | "waiting" | "warn";

function PcSetup() {
  const api = desktop()!.phone!;
  const assistant = useAssistantName();
  const [state, setState] = useState<PhoneState | null>(null);
  const [busy, setBusy] = useState<"" | "on" | "off" | "access">("");
  const [error, setError] = useState("");
  const [consent, setConsent] = useState("");

  const load = useCallback(() => {
    void api
      .state()
      .then(setState)
      .catch(() => setError("Couldn't read Tailscale's state."));
  }, [api]);

  // Live: sign-in and the admin page happen outside the app, so look again when the window comes back and,
  // while a step is still open, every few seconds.
  useEffect(() => {
    load();
    const again = () => document.visibilityState === "visible" && load();
    window.addEventListener("focus", again);
    document.addEventListener("visibilitychange", again);
    return () => {
      window.removeEventListener("focus", again);
      document.removeEventListener("visibilitychange", again);
    };
  }, [load]);
  const complete = !!state?.url && !state.moved;
  useEffect(() => {
    if (complete || busy) return;
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [complete, busy, load]);

  const open = (url: string) => void api.open(url);
  const turnOn = async () => {
    setBusy("on");
    setError("");
    setConsent("");
    const r = await api.enable(state?.port ?? undefined).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e), consentUrl: "" }));
    if (!r.ok) {
      setError(r.error || "Phone access couldn't be turned on.");
      setConsent(r.consentUrl || "");
    }
    setBusy("");
    load();
  };
  const turnOff = async () => {
    setBusy("off");
    setError("");
    const r = await api.disable();
    if (!r.ok) setError(r.error || "Phone access couldn't be turned off.");
    setBusy("");
    load();
  };
  const setAccess = async (mode: "owner" | "tailnet") => {
    if (state?.access === mode) return;
    setBusy("access");
    setError("");
    const r = await api.setAccess(mode);
    if (!r.ok) setError(r.error || "That couldn't be changed.");
    // The dashboard server restarted to read it: give it a moment, then look again.
    await new Promise((res) => setTimeout(res, 1500));
    setBusy("");
    load();
  };

  if (!state) {
    return (
      <Group icon={<SmartphoneIcon className="size-4" />} title="Phone access">
        <Row label="Checking Tailscale…" hint={error} />
      </Group>
    );
  }

  const running = state.installed && state.backend === "Running";
  const s1: StepStatus = running ? "done" : "todo";
  const s2: StepStatus = !running ? "waiting" : state.https ? "done" : "todo";
  const s3: StepStatus = !running || !state.https ? "waiting" : state.moved ? "warn" : state.url ? "done" : "todo";

  return (
    <>
      <Group
        icon={<SmartphoneIcon className="size-4" />}
        title="Phone access"
        hint={`Use ${assistant} on your phone from anywhere, privately. Your PC and phone join a Tailscale network of their own: nothing is opened to the internet.`}
        action={<PillButton onClick={load}>Check again</PillButton>}
      >
        <Step n={1} status={s1} title="Tailscale on this PC" hint={
          !state.installed
            ? "Free for personal use. Install it, sign in, then come back here."
            : state.error
              ? state.error
              : running
                ? `Signed in as ${state.login || "your account"} · ${state.dnsName}`
                : state.backend === "NeedsLogin"
                  ? "Installed. Open Tailscale from the system tray (or the Start menu) and sign in."
                  : "Installed, but not connected. Open Tailscale from the system tray and connect."
        }>
          {!state.installed ? <Action primary onClick={() => open(LINKS.windows)} icon={<ExternalLinkIcon className="size-3.5" />}>Get Tailscale</Action> : null}
        </Step>
        <Step n={2} status={s2} title="A secure address" hint={
          s2 === "done"
            ? "HTTPS certificates are on for your Tailscale network."
            : s2 === "waiting"
              ? "Next: turn on HTTPS certificates, so your phone gets a trusted https:// address."
              : "On Tailscale's DNS page, turn on MagicDNS and HTTPS Certificates, then come back."
        }>
          {s2 === "todo" ? <Action primary onClick={() => open(LINKS.dns)} icon={<ExternalLinkIcon className="size-3.5" />}>Open DNS settings</Action> : null}
        </Step>
        <Step n={3} status={s3} title="Phone access" hint={
          s3 === "done"
            ? state.url
            : s3 === "warn"
              ? `${assistant} moved to port ${state.uiPort} (the old one was busy), so the phone address points nowhere. Fix it to point it here again.`
              : s3 === "waiting"
                ? "Next: one click adds a private https:// address for this app."
                : state.port === null
                  ? "Every port Tailscale Serve can use (443, 8443 and 10000) already serves something else on this PC."
                  : `Adds one private address for ${assistant} to Tailscale Serve${state.port !== 443 ? ` on port ${state.port} (443 is in use)` : ""}. Other Serve entries on this PC are left alone.`
        }>
          {s3 === "todo" && state.port !== null ? (
            <Action primary disabled={!!busy} onClick={() => void turnOn()}>
              {busy === "on" ? "Turning on…" : "Turn on"}
            </Action>
          ) : s3 === "warn" ? (
            <Action primary disabled={!!busy} onClick={() => void turnOn()}>
              {busy === "on" ? "Fixing…" : "Fix it"}
            </Action>
          ) : s3 === "done" ? (
            <Action disabled={!!busy} onClick={() => void turnOff()}>
              {busy === "off" ? "Turning off…" : "Turn off"}
            </Action>
          ) : null}
        </Step>
        {error ? (
          <div className="px-3.5 py-3" role="alert">
            <p className="flex items-start gap-2 text-callout text-danger">
              <CircleAlertIcon className="mt-0.5 size-4 shrink-0" />
              <span>{error}</span>
            </p>
            {consent ? (
              <div className="mt-2 flex flex-wrap items-center gap-2 pl-6">
                <Action primary onClick={() => open(consent)} icon={<ExternalLinkIcon className="size-3.5" />}>Allow it in Tailscale</Action>
                <span className="text-caption text-fg-3">Then click Turn on again.</span>
              </div>
            ) : null}
          </div>
        ) : null}
      </Group>

      {state.url ? <YourPhone url={state.url} login={state.login} onOpen={open} /> : null}
      {running ? <WhoCanOpen state={state} busy={busy === "access"} onChange={(m) => void setAccess(m)} /> : null}
      {state.url ? <AlertsGroup /> : null}
    </>
  );
}

function YourPhone({ url, login, onOpen }: { url: string; login: string; onOpen: (url: string) => void }) {
  const assistant = useAssistantName();
  const [copied, setCopied] = useState(false);
  const copy = () =>
    void navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  return (
    <Group icon={<LinkIcon className="size-4" />} title="On your phone" hint="Five steps, once per phone.">
      <div className="flex flex-col gap-5 px-3.5 py-4 sm:flex-row sm:items-start">
        <div className="flex shrink-0 flex-col items-center gap-2 self-center sm:self-start">
          <div className="rounded-[14px] border border-line-2 bg-white p-2">
            <QrCode value={url} label={`QR code for ${url}`} />
          </div>
          <span className="text-caption text-fg-3">Scan with the phone&apos;s camera</span>
        </div>
        <div className="min-w-0 flex-1 space-y-4">
          <div className="flex items-center gap-2 rounded-ctl border border-line-2 bg-canvas py-1 pl-3 pr-1">
            <span className="min-w-0 flex-1 truncate font-mono text-code text-fg" title={url}>
              {url}
            </span>
            <button type="button" onClick={copy} aria-label="Copy the address" className="press grid size-9 shrink-0 place-items-center rounded-full text-fg-2 hover:bg-white/[0.06] hover:text-fg">
              {copied ? <CheckIcon className="size-4 text-ok" /> : <CopyIcon className="size-4" />}
            </button>
          </div>
          <ol className="space-y-3">
            <Numbered n={1} title="Install Tailscale on the phone">
              <div className="mt-1.5 flex flex-wrap gap-2">
                <Action onClick={() => onOpen(LINKS.play)} icon={<ExternalLinkIcon className="size-3.5" />}>Google Play</Action>
                <Action onClick={() => onOpen(LINKS.appStore)} icon={<ExternalLinkIcon className="size-3.5" />}>App Store</Action>
              </div>
            </Numbered>
            <Numbered n={2} title="Sign in with the same account">{login ? <span className="text-fg-3"> {login}</span> : null}</Numbered>
            <Numbered n={3} title="Scan the code, or type the address" />
            <Numbered n={4} title={`Add ${assistant} to the home screen`}>
              <p className="mt-0.5 text-caption text-fg-3">Android: in Chrome, tap ⋮, then Install app (or Add to Home screen). iPhone: in Safari, tap Share, then Add to Home Screen.</p>
            </Numbered>
            <Numbered n={5} title="Turn on alerts">
              <p className="mt-0.5 text-caption text-fg-3">Open {assistant} from the home screen, then Settings → Phone → Turn on alerts.</p>
            </Numbered>
          </ol>
        </div>
      </div>
    </Group>
  );
}

function WhoCanOpen({ state, busy, onChange }: { state: PhoneState; busy: boolean; onChange: (mode: "owner" | "tailnet") => void }) {
  const assistant = useAssistantName();
  const options: { mode: "owner" | "tailnet"; title: string; hint: string }[] = [
    { mode: "owner", title: "Only you", hint: state.access === "owner" && state.allowed ? state.allowed : state.login || "Your Tailscale account" },
    { mode: "tailnet", title: "Anyone on your Tailscale network", hint: "Includes people you've shared devices with, and everyone on a work network." },
  ];
  return (
    <Group icon={<UsersIcon className="size-4" />} title={`Who can open ${assistant}`} hint={busy ? "Applying… the dashboard restarts for a second." : `Anyone allowed here has full use of ${assistant}.`}>
      <div role="radiogroup" aria-label={`Who can open ${assistant}`} className="grid gap-2 p-2 sm:grid-cols-2">
        {options.map((o) => {
          const on = state.access === o.mode;
          return (
            <button
              key={o.mode}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={busy}
              onClick={() => onChange(o.mode)}
              className={`press flex items-start gap-2.5 rounded-[12px] border px-3 py-2.5 text-left transition-colors disabled:opacity-60 ${on ? "border-accent/60 bg-accent/[0.08]" : "border-line-2 hover:bg-white/[0.03]"}`}
            >
              <span className={`mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border ${on ? "border-accent" : "border-line-3"}`}>
                {on ? <span className="size-2 rounded-full bg-accent" /> : null}
              </span>
              <span className="min-w-0">
                <span className="block text-callout font-medium text-fg">{o.title}</span>
                <span className="block break-words text-caption text-fg-3">{o.hint}</span>
              </span>
            </button>
          );
        })}
      </div>
      {state.access === "tailnet" ? (
        <p role="note" className="mx-2 mb-2 rounded-ctl border border-warn/30 bg-warn/10 px-3 py-2 text-caption text-warn">
          Every login that can reach this PC on Tailscale can read your chats and notes, and approve commands. That includes
          people a device was shared with. Choose Only you unless you share this PC on purpose.
        </p>
      ) : null}
    </Group>
  );
}

/* ------------------------------------------------------------------ alerts (both) */

function AlertsGroup({ children }: { children?: ReactNode }) {
  const assistant = useAssistantName();
  const [count, setCount] = useState<number | null>(null);
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const refresh = useCallback(() => void pushDeviceCount().then(setCount), []);
  useEffect(refresh, [refresh]);
  return (
    <Group icon={<BellIcon className="size-4" />} title="Phone alerts" hint={`Replies and approvals from ${assistant} arrive as notifications, even with the app closed.`}>
      {children}
      <Row
        label={count === null ? "Alerts" : count === 0 ? "No device gets alerts yet" : `Alerts go to ${count} ${count === 1 ? "device" : "devices"}`}
        hint={note || (count === 0 ? "Turn them on from the phone: Settings → Phone → Turn on alerts." : "Send one to check they arrive.")}
      >
        <div className="mt-2">
          <Action
            disabled={sending || !count}
            onClick={() => {
              setSending(true);
              setNote("");
              void sendTestPush(assistant)
                .then((r) => setNote(r.ok ? (r.sent ? `Sent to ${r.sent} ${r.sent === 1 ? "device" : "devices"}. It should arrive within a few seconds.` : "No device took it. Turn alerts on again on the phone.") : r.error || "The test alert couldn't be sent."))
                .finally(() => {
                  setSending(false);
                  refresh();
                });
            }}
          >
            {sending ? "Sending…" : "Send a test alert"}
          </Action>
        </div>
      </Row>
    </Group>
  );
}

/* ------------------------------------------------------------------ the phone */

function ThisPhone() {
  const assistant = useAssistantName();
  const platform = phonePlatform();
  const [standalone, setStandalone] = useState(false);
  const [canInstall, setCanInstall] = useState(false);
  const [push, setPush] = useState<PushStatus | null>(null);
  const [available, setAvailable] = useState(true);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  useEffect(() => {
    setStandalone(isStandalone());
    setCanInstall(canPromptInstall());
    void pushStatus().then(setPush);
    void pushCapability().then((c) => setAvailable(c.available));
    return onInstallPromptChange(() => setCanInstall(canPromptInstall()));
  }, []);
  // iPhone shows web alerts only for an app opened from the home screen.
  const needsHomeScreen = platform === "ios" && !standalone;
  return (
    <>
      <Group icon={<SmartphoneIcon className="size-4" />} title="This phone">
        <Row
          label={standalone ? `${assistant} is on your home screen` : `Add ${assistant} to your home screen`}
          hint={
            standalone
              ? "It opens full screen, like an app."
              : platform === "ios"
                ? "In Safari, tap Share, then Add to Home Screen. Then open it from there: iPhone sends alerts only to apps opened that way."
                : canInstall
                  ? "It opens full screen, like an app, and keeps alerts working."
                  : "In Chrome, tap ⋮, then Install app (or Add to Home screen)."
          }
        >
          {!standalone && canInstall ? (
            <div className="mt-2">
              <Action primary onClick={() => void promptInstall().then((ok) => ok && setStandalone(true))}>
                Install app
              </Action>
            </div>
          ) : null}
        </Row>
      </Group>
      <AlertsGroup>
        <Row
          label="Alerts on this phone"
          hint={
            note ||
            (!available
              ? "Alerts aren't available from this PC right now."
              : push === "on"
                ? "On."
                : push === "blocked"
                  ? "Notifications are blocked for Chief. Allow them in the phone's settings for this app, then turn alerts on."
                  : needsHomeScreen
                    ? "Add it to the home screen first (above), then open it from there."
                    : push === "unsupported"
                      ? "This browser can't receive alerts. Use Chrome on Android, or the home-screen app on iPhone."
                      : "Off.")
          }
        >
          <div className="mt-2 flex flex-wrap gap-2">
            {push === "on" ? (
              <Action
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  void disableWebPush()
                    .then((r) => setNote(r.ok ? "Alerts are off on this phone." : r.error || "Couldn't turn them off."))
                    .then(() => pushStatus().then(setPush))
                    .finally(() => setBusy(false));
                }}
              >
                Stop alerts here
              </Action>
            ) : (
              <Action
                primary
                disabled={busy || !available || push === "blocked" || push === "unsupported" || needsHomeScreen}
                onClick={() => {
                  setBusy(true);
                  setNote("");
                  void enableWebPush()
                    .then((r) => setNote(r.ok ? "Alerts are on. Send a test below." : r.error === "notification permission denied" ? "Permission wasn't given. Allow notifications for Chief, then try again." : r.error || "Couldn't turn them on."))
                    .then(() => pushStatus().then(setPush))
                    .finally(() => setBusy(false));
                }}
              >
                {busy ? "Turning on…" : "Turn on alerts"}
              </Action>
            )}
          </div>
        </Row>
      </AlertsGroup>
    </>
  );
}

/* ------------------------------------------------------------------ pieces */

function Step({ n, status, title, hint, children }: { n: number; status: StepStatus; title: string; hint: string; children?: ReactNode }) {
  return (
    <div className={`flex items-start gap-3 px-3.5 py-3 transition-opacity duration-fast ${status === "waiting" ? "opacity-55" : ""}`}>
      <span
        aria-hidden="true"
        className={`mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-caption font-semibold tabular ${
          status === "done" ? "bg-ok/15 text-ok" : status === "warn" ? "bg-warn/15 text-warn" : status === "todo" ? "bg-accent/15 text-accent-text" : "bg-white/[0.06] text-fg-3"
        }`}
      >
        {status === "done" ? <CheckIcon className="size-3.5" /> : status === "warn" ? "!" : n}
      </span>
      <div className="min-w-0 flex-1">
        <p className="text-body text-fg">
          <span className="sr-only">{status === "done" ? "Done: " : status === "warn" ? "Needs attention: " : `Step ${n}: `}</span>
          {title}
        </p>
        <p className={`mt-0.5 break-words text-caption ${status === "done" && n === 3 ? "font-mono text-fg-2" : "text-fg-3"}`}>{hint}</p>
      </div>
      {children ? <div className="shrink-0 self-center">{children}</div> : null}
    </div>
  );
}

function Numbered({ n, title, children }: { n: number; title: string; children?: ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span aria-hidden="true" className="mt-px grid size-5 shrink-0 place-items-center rounded-full bg-white/[0.06] text-caption font-semibold tabular text-fg-2">
        {n}
      </span>
      <div className="min-w-0 flex-1 text-callout text-fg">
        {title}
        {children}
      </div>
    </li>
  );
}

function Action({ children, onClick, disabled, primary, icon }: { children: ReactNode; onClick: () => void; disabled?: boolean; primary?: boolean; icon?: ReactNode }) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className={`press inline-flex min-h-9 items-center gap-1.5 rounded-full px-3.5 text-callout font-medium disabled:opacity-45 ${primary ? "bg-fg text-canvas" : "border border-line-2 text-fg-2 hover:text-fg"}`}
    >
      {children}
      {icon}
    </button>
  );
}
