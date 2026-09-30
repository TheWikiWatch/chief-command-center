// Builds docs/visual-overhaul/gallery.html: before/after pairs by file name. Local only (gitignored).
// Usage: node docs/visual-overhaul/gallery.mjs
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const list = (dir) => (existsSync(path.join(here, dir)) ? readdirSync(path.join(here, dir)).filter((f) => f.endsWith(".png")) : []);
const before = new Set(list("before"));
const after = new Set(list("after"));
const names = [...new Set([...before, ...after])].sort((a, b) => {
  const pa = a.startsWith("phone") ? 0 : 1;
  const pb = b.startsWith("phone") ? 0 : 1;
  return pa - pb || a.localeCompare(b);
});

const cell = (dir, name, set) =>
  set.has(name)
    ? `<a href="${dir}/${name}" target="_blank"><img loading="lazy" src="${dir}/${name}" alt="${dir} ${name}"></a>`
    : `<div class="none">no ${dir} capture</div>`;

const rows = names
  .map((name) => {
    const label = name.replace(/\.png$/, "");
    const phone = name.startsWith("phone");
    return `<section class="${phone ? "phone" : "desk"}"><h2>${label}</h2><div class="pair">${cell("before", name, before)}${cell("after", name, after)}</div></section>`;
  })
  .join("\n");

const html = `<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Chief visual overhaul — before and after</title>
<style>
  body { margin: 0; padding: 24px; background: #09090b; color: #ededef; font: 14px/1.5 system-ui, sans-serif; }
  h1 { font-size: 20px; margin: 0 0 4px; } p.meta { color: #a1a1aa; margin: 0 0 24px; }
  section { margin: 0 0 40px; } h2 { font-size: 14px; font-weight: 600; color: #a1a1aa; margin: 0 0 8px; }
  .pair { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .phone .pair { grid-template-columns: repeat(2, minmax(0, 390px)); }
  .pair::before { content: "Before"; } .pair::after { content: "After"; }
  .pair::before, .pair::after { display: none; }
  img { width: 100%; border-radius: 12px; border: 1px solid rgb(255 255 255 / .1); display: block; }
  .none { border: 1px dashed rgb(255 255 255 / .16); border-radius: 12px; display: grid; place-items: center; color: #85858e; min-height: 160px; }
  .legend { display: grid; grid-template-columns: repeat(2, minmax(0, 390px)); gap: 16px; color: #85858e; margin-bottom: 8px; }
</style>
<h1>Chief Command Center — before and after</h1>
<p class="meta">${names.length} scenarios · generated ${new Date().toLocaleString()}</p>
<div class="legend"><span>Before</span><span>After</span></div>
${rows}
`;

writeFileSync(path.join(here, "gallery.html"), html);
console.log(`gallery.html: ${names.length} scenarios (${before.size} before, ${after.size} after)`);
