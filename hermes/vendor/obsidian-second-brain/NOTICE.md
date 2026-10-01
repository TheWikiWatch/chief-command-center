# obsidian-second-brain 0.17.0

Vendored from https://github.com/eugeniughelbur/obsidian-second-brain at `v0.17.0` (commit `87fe5437c44fffafb5188566d458891651536d4e`), built with the toolkit's own
`bash scripts/build.sh --platform hermes`. MIT licensed, copyright (c) 2026 Eugeniu Ghelbur (see LICENSE).

Left out of the app's default install:

- `skills/research`: needs paid API keys and large downloads (Whisper, PyTorch); opt-in later
- `skills/meta/create-command`: authoring tooling for the toolkit's own repository
- `skills/meta/obsidian-retrieval-eval`: benchmark that needs a local Ollama model

Re-vendor a newer release with `python packaging/upstream/osb_vendor.py --tag <tag>`, then run the
compatibility suite. Provisioning points the skills' script calls at the app's own Python.
