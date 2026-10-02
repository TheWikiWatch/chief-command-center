"use client";

import { useEffect, useState } from "react";
import { BellIcon, PlayIcon, VibrateIcon, Volume2Icon } from "@/components/icons";
import { Group, Row } from "@/components/ui/settings-group";
import { canVibrate, PREVIEW_VARIANT, previewHaptic, previewSound } from "@/lib/fx";
import { FX_EVENT_LABELS, FX_EVENTS, updateFx, useFxPrefs, type FxEvent } from "@/lib/fx-prefs";
import { enableWebPush, pushCapability, pushStatus, type PushStatus } from "@/lib/web-push";
import { useAssistantName } from "@/lib/identity";
import { btn } from "@/components/ui/button";
import { SwitchRow } from "@/components/settings/shared";

/* Settings → Notifications: sounds, vibration and alerts on this device. */

export function SoundGroup() {
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

export function HapticsGroup() {
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

export function EventRow({ kind, event, checked, disabled }: { kind: "sound" | "haptics"; event: FxEvent; checked: boolean; disabled: boolean }) {
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
            className="press grid size-9 shrink-0 place-items-center rounded-full text-fg-3 hover:bg-fill-2 hover:text-fg disabled:opacity-40"
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

export function NotificationsGroup() {
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
          className={btn("primary", "md")}
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
