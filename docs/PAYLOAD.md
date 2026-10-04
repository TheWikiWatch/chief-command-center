# The Hermes payload: what ships, and what could go

Measured 2026-10-02 on the payload built from `hermes/pin.json` (Hermes 2026.9.24, upstream 41cd311, then 3 patches; the 2026-10-04 build with patch 0004 is the same size).

## Size

| Part | On disk | In the package |
| --- | --- | --- |
| `tools/ffmpeg` | 480 MB | 310 MB (`ffplay.exe`, 158 MB, and the HTML docs, 12 MB, are left out) |
| `tools/git` (full portable Git, with bash) | 357 MB | 357 MB |
| `tools/python` | 155 MB | 155 MB |
| `tools/node` + `npm` | 132 MB | 132 MB |
| `tools/uv`, `ripgrep` | 52 MB | 52 MB |
| `venv` (Python packages) | 649 MB | 649 MB |
| `hermes-agent` | 128 MB | 128 MB (minus `__pycache__`) |
| `uv-cache` (the builder's download cache) | 939 MB | never shipped |
| **Total** | **2.9 GB** | **about 1.8 GB** |

`apps/desktop/electron-builder.config.cjs` holds the exclusions. Compiled Python isn't shipped either: the app compiles it once into `<data>\pycache` (`PYTHONPYCACHEPREFIX`).

## Python extras (`packaging/payload/selection.json`)

The payload installs these Hermes extras: all, acp, audio-io, bedrock, discord, doc-extract, edge-tts, fal, firecrawl, google, stt-whisper, trace-upload, tts-premium, vertex, vision, web, youtube.

Sizes are the extra's own packages plus the large dependencies only it brings in.

| Extra | Size | What uses it | Recommendation |
| --- | --- | --- | --- |
| `google` | ~100 MB (`googleapiclient` keeps every Google API's discovery document) | Hermes's Google Workspace skill and Google Chat platform. Not the Gemini models: Google AI Studio goes through Hermes's own Gemini adapter over plain HTTP (`agent/gemini_native_adapter.py`, httpx). | **Candidate.** The app doesn't expose Google Chat or set up Workspace OAuth. Removing it turns off the Workspace skill for anyone who set it up by hand. |
| `stt-whisper` | ~200 MB (ctranslate2, av, onnxruntime, tokenizers) | The local speech model (Settings → Voice → on-device transcription). | Keep: the app exposes it. |
| `audio-io` | ~42 MB (numpy, sounddevice) | Local microphone and speaker in Hermes's command-line voice mode; numpy is also needed by `stt-whisper`. | Keep (numpy is shared). |
| `bedrock` | ~27 MB (boto3, botocore) | The AWS Bedrock model provider. | Candidate if no tester uses Bedrock. |
| `vertex` | ~1 MB (google-auth) | The Google Vertex AI provider. | Small; keep unless `google` goes too. |
| `discord` | ~9 MB | The legacy Discord DM path (see FRAGILE_SEAMS, "Bridge routes and Hermes names"). | Keep until diagnostics show no install uses it. |
| `trace-upload` | ~3 MB | Hermes's trace upload to Hugging Face. | Small; candidate. |
| `youtube`, `firecrawl`, `fal`, `tts-premium`, `edge-tts`, `acp`, `web` | under 3 MB each | Web reading, image generation, premium voices, the ACP adapter, Hermes's own web UI. | Keep (small, and some are reachable from the app). |

Removing an extra means editing `selection.json`, rebuilding the payload, running the compatibility suite and checking the provider list in onboarding. Expected saving if `google`, `bedrock` and `trace-upload` go: about 130 MB.

## Larger options, evaluated

- **MinGit instead of full portable Git (-300 MB):** not possible as is. Hermes's terminal tool runs commands in the bash that ships with full Git (`usr/bin`), and MinGit has no bash.
- **A shared-DLL ffmpeg (-150 to -200 MB):** `ffmpeg.exe` and `ffprobe.exe` are static builds of about 156 MB each. A shared build puts the codecs in DLLs both use, about 120 MB in total. It needs a different download in Hermes's tool manifest (a patch to the payload builder) and a check that `av` (PyAV) doesn't load a second copy of the DLLs. Worth doing with the next Hermes upgrade.
- **Test folders inside the Python packages (-23 MB):** small, and some packages import from their test folders; not worth the risk.

## Smaller updates

Every update ships the whole package (about 850 MB compressed), even when only the dashboard changed. Two ways out:

1. **The payload as its own MSIX package** (an optional or resource package next to the app). It is downloaded only when `hermes/pin.json` changes, so an app-only update falls to the Electron shell and the dashboard (about 120 MB). It costs a second signed package and an install that keeps the two in step. Windows installs optional packages from the main package's manifest. The updater would download two packages when Hermes changes and one otherwise.
2. **Block-map differential download:** electron-builder writes a `.blockmap` for each package, and the updater downloads only the blocks that changed (HTTP Range against the GitHub release asset). It needs no packaging change, but MSIX compresses each file, so a changed dashboard still changes many blocks. A test against two real releases is needed to see the saving.

Recommendation: prototype option 1 when the next Hermes upgrade needs a payload rebuild anyway. App-only releases are the common case, and option 1 makes them about 7 times smaller. Option 2's saving on MSIX is uncertain.
