# voicestudio-tts

A Hermes text-to-speech provider for a local [VoiceStudio](https://github.com/debpalash/VoiceStudio) backend (OmniVoice). It adds **VoiceStudio (local)** to Chief's Speaking engines, next to Edge, ElevenLabs and the rest. Nothing else changes, and every other engine keeps working.

- **Designed voices (fast):** OmniVoice builds the voice from its voice-design tags (gender, age, pitch, accent) with a fixed seed. There's no reference audio, so a first chunk takes about 1s on the RTX 4070.
- **Your VoiceStudio voices:** voices saved in the VoiceStudio app, designed or **cloned**. These use reference audio. With a short reference (~6–10s) a first chunk takes 1–2s; a 35s reference took 3.5–5s. Keep clone clips short. Only clone voices you have consent for.
- **Edge fallback:** if VoiceStudio is stopped, errors or times out, that reply is spoken by Edge (`en-GB-RyanNeural` unless configured), and the dashboard header shows **Edge fallback** for ten minutes.
- **Loopback only:** text only ever goes to `127.0.0.1`. A non-loopback `base_url` is ignored.

## Install (already done on this PC)

VoiceStudio lives in `E:\tools\VoiceStudio` (a source checkout, backend only, no Electron):

```text
set UV_CACHE_DIR=E:\tools\uv-cache
set UV_PYTHON_INSTALL_DIR=E:\tools\uv-python
cd /d E:\tools\VoiceStudio && uv sync --frozen
```

C: is nearly full, so the uv cache, the Python it downloads, the models (`HF_HOME=E:\tools\hf-cache`) and VoiceStudio's data (`E:\tools\voicestudio-data`) all live on E:. Don't run VoiceStudio's `scripts/setup.py`: it silently installs the VC++ runtime system-wide, and PyTorch already works here.

[`scripts/ensure-voicestudio.ps1`](../../scripts/ensure-voicestudio.ps1) starts the backend detached on `127.0.0.1:3900` (WMI, own process group, no window) using [`scripts/run-voicestudio.cmd`](../../scripts/run-voicestudio.cmd). The desktop shortcut runs it when 3900 is down. The log is `E:\tools\voicestudio.log`. The model loads on the first request and unloads after an hour idle; reloading a cached model takes about a second.

**The app:** open <http://127.0.0.1:3900> in a browser on this PC. The backend serves VoiceStudio's web UI, built once into `E:\tools\VoiceStudio\frontend\dist` (Bun 1.4.2 via scoop, package cache `E:\tools\bun-cache`). Don't use the Electron app (`bun run dev`): it starts its own backend on the same port. Design voices under **Design** and clone under **Clone**; both are saved to **Saved voices**. They show up in the dashboard's voice list within 30s. After updating VoiceStudio (`git pull`, `uv sync --frozen`), rebuild the UI with `bun install --frozen-lockfile && bun run build:web` in `E:\tools\VoiceStudio\electron`, then restart the backend (the UI only mounts at startup).

## Enable for Chief

1. `scripts/sync-bridge-plugin.ps1` copies this folder next to the bridge in both Hermes plugin directories (the desktop shortcut runs it).
2. Add `voicestudio-tts` under `plugins.enabled` in `profiles\chief\config.yaml`.
3. Reload Chief (`hermes -p chief gateway stop`; the guard task starts him again). Check `hermes kanban show` first: running workers are children of the gateway.
4. Dashboard → Settings → Chief's voice → Speaking → **VoiceStudio (local)**, then pick a voice. ▷ plays a sample.

To go back, pick Edge (or any other engine) in the same list. The plugin can stay installed.

## Parking (currently parked, 2026-09-27)

Parked means nothing runs: Chief is on Edge, `voicestudio-tts` is out of `plugins.enabled`, the backend is stopped, and `E:\tools\voicestudio.parked` exists. While that file exists, `ensure-voicestudio.ps1` (and so the desktop shortcut) won't start the backend. The marker file lists the four steps to bring it back. Nothing is deleted: the checkout, models and saved voices stay on E:.

## Config

Everything is optional, under `tts.voicestudio` in the chief profile's `config.yaml`:

| Key | Default | |
| --- | --- | --- |
| `voice` | `design:male, middle-aged, low pitch, british accent` | `default`, `design:<tags>`, or `profile:<id>`. The dashboard writes this. |
| `seed` | `7` | Fixed seed for designed voices, so the voice stays the same from chunk to chunk. |
| `num_step` | VoiceStudio's 16 | OmniVoice steps. 8–12 is faster, 32 is its quality preset. |
| `speed` | `1.0` | Rate multiplier. |
| `timeout` | `12` | Seconds per chunk before falling back (longer text gets proportionally more). |
| `fallback` | `true` | `false` makes a failure an error instead of Edge speech. |
| `fallback_voice` | `en-GB-RyanNeural` | Edge voice for the fallback. |
| `base_url` | `http://127.0.0.1:3900` | Loopback only. |

## Security

VoiceStudio's backend is unauthenticated on loopback, and its admin routes (`/system/*`, `/api/settings/*`) can execute code. Keep it bound to `127.0.0.1` and never put port 3900 behind Tailscale Serve or Funnel. Check with `tailscale serve status` that nothing serves it.

VoiceStudio is AGPL-3.0, which is fine for personal use unmodified. Model weights carry their own licenses (see each model card).

## Tests

`npm run test:python` runs `tests/python/test_voicestudio.py`, which covers request shapes per voice kind, the Edge fallback, loopback enforcement, voice listing with a stopped backend, and the bridge's plugin-voice branches.
