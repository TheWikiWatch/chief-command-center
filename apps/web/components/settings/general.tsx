"use client";

import { useEffect, useState } from "react";
import { SlidersHorizontalIcon, BotIcon, MessageCircleIcon, PencilIcon } from "@/components/icons";
import { fetchSettings, patchSettings } from "@/lib/bridge";
import { Group, Row } from "@/components/ui/settings-group";
import { Segmented } from "@/components/ui/controls";
import { FONT_STEPS, useDashboardPrefs } from "@/lib/dashboard-prefs";
import { updateFx, useFxPrefs, type AmbientPref, type MotionPref, type UiScale } from "@/lib/fx-prefs";
import { toggleFullscreen, useFullscreen } from "@/lib/use-fullscreen";
import { stopSpeech } from "@/lib/voice-client";
import { useAssistantName, setAssistantTitle } from "@/lib/identity";
import { NameEditor } from "@/components/persona/name-editor";
import { splitTitle } from "@/lib/names";
import type { Person } from "@/lib/types";
import { PersonaEditor } from "@/components/persona/persona-editor";
import { SwitchRow } from "@/components/settings/shared";

/* Settings → General: the chief's name, identity and memory, and how this app looks on this device. */

/** General: the chief's name and role (any other bot is renamed from its Look drawer). */
export function ChiefNameGroup({ chief }: { chief?: Person }) {
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

export function IdentityGroup() {
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

/* ------------------------------------------------------------------ replies (Hermes) */

/** How replies arrive, for every device: Hermes's streaming switch (read at the gateway's start). */
export function RepliesGroup() {
  const assistant = useAssistantName();
  const [on, setOn] = useState<boolean | null>(null);
  const [note, setNote] = useState("");
  useEffect(() => {
    let live = true;
    fetchSettings()
      .then((s) => {
        if (live) setOn(!!s.streaming);
      })
      .catch(() => {
        if (live) setNote("Couldn't read this setting right now.");
      });
    return () => {
      live = false;
    };
  }, []);
  return (
    <Group icon={<MessageCircleIcon className="size-4" />} title="Replies" hint={`How ${assistant}'s replies arrive in the chat, on every device.`}>
      <SwitchRow
        label="Show replies as they're written"
        hint={note || `The text appears as ${assistant} writes it instead of all at once. Takes effect the next time ${assistant} starts.`}
        checked={!!on}
        disabled={on === null}
        onChange={async (next) => {
          setOn(next);
          setNote("");
          try {
            await patchSettings({ streaming: next });
            setNote(`Saved. Takes effect the next time ${assistant} starts (tray icon → Restart Chief, or the next app start).`);
          } catch (e) {
            setOn(!next);
            setNote(e instanceof Error ? e.message : "Couldn't save.");
          }
        }}
      />
    </Group>
  );
}

/* ------------------------------------------------------------------ this device */

export function AppGroup({ phone }: { phone: boolean }) {
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
