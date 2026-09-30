import path from "node:path";

/**
 * The environment the app gives Hermes and the dashboard server (PLAN §4, Phase 2 finding).
 *
 * A new install must not inherit ambient credentials or another Hermes install's settings: on a fresh home,
 * Hermes picked up the `gh` CLI login as a GitHub Copilot provider, and this PC has a machine-wide HERMES_HOME
 * from an older installer. So children get a short allow-list of Windows basics, a PATH made of the payload's
 * own tools plus the system folders, and exactly the variables the app sets. An adopted install (the
 * migration) may opt into passing the user's PATH through, because its skills and routines may rely on it.
 */
const PASS_THROUGH = [
  "SystemRoot", "SYSTEMROOT", "windir", "WINDIR", "SystemDrive", "ComSpec", "COMSPEC", "PATHEXT",
  "TEMP", "TMP", "USERPROFILE", "USERNAME", "USERDOMAIN", "COMPUTERNAME", "HOMEDRIVE", "HOMEPATH",
  "APPDATA", "LOCALAPPDATA", "ProgramData", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432",
  "CommonProgramFiles", "CommonProgramFiles(x86)", "PUBLIC", "ALLUSERSPROFILE", "OS",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "LANG", "LC_ALL", "TZ",
  // Proxies and custom certificate stores are machine networking, not credentials.
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE",
];

export type PayloadLayout = { root: string; launcher: string; python: string; toolDirs: string[] };

/** Where things are inside a Hermes PM payload (packaging/payload/stage.py). */
export function payloadLayout(root: string, toolNames: string[] = []): PayloadLayout {
  return {
    root,
    launcher: path.join(root, "bin", "hermes.exe"),
    python: path.join(root, "venv", "Scripts", "python.exe"),
    toolDirs: [path.join(root, "bin"), path.join(root, "venv", "Scripts"), ...toolNames.map((t) => path.join(root, "tools", t))],
  };
}

export function curatedEnv(
  source: NodeJS.ProcessEnv,
  opts: { payload: PayloadLayout; set: Record<string, string>; inheritUserPath?: boolean },
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of PASS_THROUGH) {
    const value = source[key];
    if (value !== undefined && value !== "") out[key] = value;
  }
  const systemRoot = out.SystemRoot || out.SYSTEMROOT || "C:\\Windows";
  const system = [path.join(systemRoot, "System32"), systemRoot, path.join(systemRoot, "System32", "Wbem"), path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0")];
  const userPath = opts.inheritUserPath ? (source.PATH || source.Path || "").split(path.delimiter).filter(Boolean) : [];
  out.PATH = [...new Set([...opts.payload.toolDirs, ...system, ...userPath])].join(path.delimiter);
  for (const [key, value] of Object.entries(opts.set)) out[key] = value;
  return out;
}

/** What must never cross from the user's session into a new install's children (used by tests). */
export function leakedKeys(env: Record<string, string>): string[] {
  return Object.keys(env).filter(
    (k) => /^(HERMES_|OPENAI|ANTHROPIC|OPENROUTER|GH_|GITHUB_|GOOGLE_|AWS_|AZURE_)/i.test(k) || /(API_KEY|TOKEN|SECRET)$/i.test(k),
  );
}
