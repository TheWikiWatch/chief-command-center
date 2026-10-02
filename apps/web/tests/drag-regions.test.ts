import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";

// In the desktop app a drag region claims every pixel it covers, whatever is painted on top of it (Electron adds
// drag regions and subtracts no-drag ones in page order; browsers ignore both, so no browser test sees this).
// A free-standing strip (an `app-drag` element positioned over other content, not a header holding its own
// controls) therefore needs the controls laid over it marked `app-no-drag`, or content scrolling under it
// marked `app-clickable` (app/globals.css). Fleet's buttons stopped answering clicks once without this.
const root = path.resolve(__dirname, "..", "components");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? files(full) : name.endsWith(".tsx") ? [full] : [];
  });
}

it("every free-standing drag strip comes with controls marked clickable", () => {
  const strips = files(root).filter((file) => /className="[^"]*\bapp-drag\b[^"]*\b(absolute|sticky|fixed)\b/.test(readFileSync(file, "utf8")));
  expect(strips.length).toBeGreaterThan(0);
  for (const file of strips) {
    const source = readFileSync(file, "utf8");
    expect(/\bapp-(no-drag|clickable)\b/.test(source), `${path.relative(root, file)} has a drag strip but nothing marked app-no-drag or app-clickable`).toBe(true);
  }
});

it("the desktop Fleet controls over the strip are marked no-drag", () => {
  const shell = readFileSync(path.join(root, "command-shell.tsx"), "utf8");
  const strip = shell.indexOf('className="app-drag absolute inset-x-0 top-0');
  expect(strip).toBeGreaterThan(-1);
  const after = shell.slice(strip, strip + 900);
  expect(after.match(/className="app-no-drag /g)?.length).toBe(2);
});
