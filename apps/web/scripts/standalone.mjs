// After `next build`: copy the static assets next to the standalone server, as the desktop app runs it
// (Next leaves .next/static and public out of .next/standalone on purpose).
//
// Turbopack can also leave symbolic links in the output (a hashed alias such as .next/node_modules/shiki-<hash>
// pointing back into this checkout's node_modules). An installed package can't hold links, and the target
// wouldn't exist there anyway, so each link is replaced by a real copy of what it points at.
import { cpSync, existsSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import path from "node:path";

const web = path.resolve(import.meta.dirname, "..");
const out = path.join(web, ".next", "standalone");
if (!existsSync(path.join(out, "server.js"))) {
  console.error("No .next/standalone/server.js; run `next build` first.");
  process.exit(1);
}
cpSync(path.join(web, ".next", "static"), path.join(out, ".next", "static"), { recursive: true });
cpSync(path.join(web, "public"), path.join(out, "public"), { recursive: true });

function dereferenceLinks(dir) {
  let replaced = 0;
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) {
      const target = realpathSync(full);
      rmSync(full, { recursive: true, force: true });
      cpSync(target, full, { recursive: true, dereference: true });
      replaced += 1;
    } else if (stat.isDirectory()) {
      replaced += dereferenceLinks(full);
    }
  }
  return replaced;
}

const links = dereferenceLinks(out);
console.log(`standalone ready: ${out}${links ? ` (${links} link${links === 1 ? "" : "s"} replaced by copies)` : ""}`);
