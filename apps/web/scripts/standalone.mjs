// After `next build`: copy the static assets next to the standalone server, as the desktop app runs it
// (Next leaves .next/static and public out of .next/standalone on purpose).
import { cpSync, existsSync } from "node:fs";
import path from "node:path";

const web = path.resolve(import.meta.dirname, "..");
const out = path.join(web, ".next", "standalone");
if (!existsSync(path.join(out, "server.js"))) {
  console.error("No .next/standalone/server.js; run `next build` first.");
  process.exit(1);
}
cpSync(path.join(web, ".next", "static"), path.join(out, ".next", "static"), { recursive: true });
cpSync(path.join(web, "public"), path.join(out, "public"), { recursive: true });
console.log(`standalone ready: ${out}`);
