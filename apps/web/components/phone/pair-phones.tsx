"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { CheckIcon, SmartphoneIcon } from "@/components/icons";
import { QrCode } from "@/components/phone/qr-code";
import { Button } from "@/components/ui/button";
import { ConfirmRow } from "@/components/ui/confirm-row";
import { Group } from "@/components/ui/settings-group";
import { useAssistantName } from "@/lib/identity";
import { friendlyError, requestJson } from "@/lib/request";

/*
 * Settings → Phone on the PC: pairing phones (lib/server/phone-devices.ts). A phone that reaches Chief through
 * Tailscale also needs a device cookie it gets once, from a one-time code shown here (scan it, or type it on the
 * phone). Removing a phone signs it out at once.
 */

type Device = { id: string; name: string; created: string; lastSeen: string };
type Code = { code: string; expiresAt: number };

const when = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" }) : "";
};

export function PairPhones({ url }: { url: string }) {
  const assistant = useAssistantName();
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [code, setCode] = useState<Code | null>(null);
  const [left, setLeft] = useState(0);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [confirm, setConfirm] = useState("");
  const [paired, setPaired] = useState("");
  // The phones there were when the code was made: a new one means the code was used.
  const before = useRef<Set<string> | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await requestJson<{ ok: boolean; devices: Device[] }>("/api/phone/devices", { cache: "no-store" });
      setDevices(res.devices);
      const known = before.current;
      const added = known ? res.devices.find((d) => !known.has(d.id)) : undefined;
      if (added) {
        before.current = null;
        setCode(null);
        setPaired(added.name);
      }
    } catch {
      setError("Couldn't read the paired phones.");
    }
  }, []);

  useEffect(() => {
    let live = true;
    requestJson<{ ok: boolean; devices: Device[] }>("/api/phone/devices", { cache: "no-store" })
      .then((res) => live && setDevices(res.devices))
      .catch(() => live && setError("Couldn't read the paired phones."));
    return () => {
      live = false;
    };
  }, []);

  // While a code is shown: count down, and look for the phone that used it.
  useEffect(() => {
    if (!code) return;
    const tick = window.setInterval(() => {
      const s = Math.max(0, Math.round((code.expiresAt - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) setCode(null);
    }, 1000);
    const poll = window.setInterval(() => void load(), 3000);
    return () => {
      window.clearInterval(tick);
      window.clearInterval(poll);
    };
  }, [code, load]);

  async function pair() {
    setBusy("pair");
    setError("");
    setPaired("");
    try {
      const res = await requestJson<{ ok: boolean; error?: string } & Code>("/api/phone/pair", { method: "POST" });
      if (!res.ok) throw new Error(res.error || "Couldn't make a code.");
      before.current = new Set((devices || []).map((d) => d.id));
      setCode({ code: res.code, expiresAt: res.expiresAt });
      setLeft(Math.round((res.expiresAt - Date.now()) / 1000));
    } catch (err) {
      setError(friendlyError(err, "Couldn't make a code. Try again."));
    } finally {
      setBusy("");
    }
  }

  async function remove(id: string) {
    setConfirm("");
    setBusy(id);
    setError("");
    setPaired("");
    try {
      await requestJson(`/api/phone/devices?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      await load();
    } catch {
      setError("Couldn't remove that phone.");
    } finally {
      setBusy("");
    }
  }

  const link = code ? `${url.replace(/\/$/, "")}/pair?code=${encodeURIComponent(code.code)}` : "";
  return (
    <Group icon={<SmartphoneIcon className="size-4" />} title="Paired phones" hint={`Each phone pairs once, with a code from here. Only paired phones can open ${assistant}, even on your Tailscale network.`}>
      <div className="space-y-3 px-3.5 py-3.5">
        {paired ? (
          <p role="status" className="flex items-center gap-2 text-callout text-ok">
            <CheckIcon className="size-4 shrink-0" />
            {paired} is paired.
          </p>
        ) : null}
        {code ? (
          <div className="flex flex-col gap-4 rounded-card border border-line-2 bg-canvas p-3.5 sm:flex-row sm:items-center">
            <div className="shrink-0 self-center rounded-card border border-line-2 bg-white p-2">
              <QrCode value={link} label={`QR code to pair a phone with code ${code.code}`} />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-callout text-fg-2">Scan it with the phone (with Tailscale on), or open {assistant} on the phone and type:</p>
              <p className="my-2 font-mono text-title tracking-widest text-fg" aria-label={`Code ${code.code.split("").join(" ")}`}>
                {code.code}
              </p>
              <p className="text-caption text-fg-3" aria-live="polite">
                Works once, for {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")} more.
              </p>
            </div>
          </div>
        ) : (
          <Button variant="primary" size="sm" disabled={!!busy} onClick={() => void pair()}>
            {busy === "pair" ? "Making a code…" : "Pair a phone"}
          </Button>
        )}
        {devices && devices.length ? (
          <ul className="divide-y divide-(--line-1) rounded-ctl border border-line">
            {devices.map((d) => (
              <li key={d.id} className="px-3 py-2.5">
                <div className="flex items-center gap-3">
                  <SmartphoneIcon className="size-4 shrink-0 text-fg-3" />
                  <div className="min-w-0 flex-1">
                    <p className="text-body text-fg">{d.name}</p>
                    <p className="text-caption text-fg-3">
                      Paired {when(d.created)}
                      {d.lastSeen ? ` · last used ${when(d.lastSeen)}` : ""}
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" disabled={!!busy || confirm === d.id} onClick={() => setConfirm(d.id)}>
                    {busy === d.id ? "Removing…" : "Remove"}
                  </Button>
                </div>
                {confirm === d.id ? (
                  <ConfirmRow className="mt-2" confirm="Remove" busy={busy === d.id} busyLabel="Removing…" onConfirm={() => void remove(d.id)} onCancel={() => setConfirm("")}>
                    Remove {d.name}? It&apos;s signed out at once, and needs a new code to come back.
                  </ConfirmRow>
                ) : null}
              </li>
            ))}
          </ul>
        ) : devices ? (
          <p className="text-caption text-fg-3">No phones paired yet.</p>
        ) : null}
        {error ? (
          <p role="alert" className="text-callout text-danger">
            {error}
          </p>
        ) : null}
      </div>
    </Group>
  );
}
