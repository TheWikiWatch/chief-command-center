import net from "node:net";

/**
 * Ports (PLAN §4): the preferred port when it's free, otherwise the next free one. A port held by something
 * else is never taken over or killed. The chosen ports are saved so the phone and Tailscale Serve keep
 * working across restarts.
 */
export function isFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ port, host, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

export type PortChoice = { ui: number; bridge: number };

/**
 * The ports for this start. A saved port is kept when it's free, and when this app's own child already holds it:
 * on Retry after a failed start the dashboard server (or the gateway) is often still running, and taking the next
 * port instead would point the window, and the phone's Tailscale Serve entry, at a port nobody listens on. A port
 * held by anything else means the next free one.
 */
export async function decidePorts(opts: {
  saved: PortChoice;
  first: boolean;
  bridgeHeld: boolean;
  uiHeld: boolean;
  probe?: (p: number) => Promise<boolean>;
}): Promise<PortChoice> {
  const probe = opts.probe ?? isFree;
  let bridge = opts.saved.bridge;
  if (!opts.bridgeHeld && !(await probe(bridge))) bridge = await pickPort(opts.first ? 7790 : bridge + 1, [], probe);
  let ui = opts.saved.ui;
  if (!opts.uiHeld && !(await probe(ui))) ui = await pickPort(opts.first ? 3000 : ui + 1, [bridge], probe);
  return { ui, bridge };
}

export async function pickPort(preferred: number, avoid: number[] = [], probe: (p: number) => Promise<boolean> = isFree, span = 50): Promise<number> {
  for (let port = preferred; port < preferred + span; port++) {
    if (avoid.includes(port)) continue;
    if (await probe(port)) return port;
  }
  throw new Error(`No free port between ${preferred} and ${preferred + span - 1}.`);
}
