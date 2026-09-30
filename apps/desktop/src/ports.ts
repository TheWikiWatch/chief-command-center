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

export async function pickPort(preferred: number, avoid: number[] = [], probe: (p: number) => Promise<boolean> = isFree, span = 50): Promise<number> {
  for (let port = preferred; port < preferred + span; port++) {
    if (avoid.includes(port)) continue;
    if (await probe(port)) return port;
  }
  throw new Error(`No free port between ${preferred} and ${preferred + span - 1}.`);
}
