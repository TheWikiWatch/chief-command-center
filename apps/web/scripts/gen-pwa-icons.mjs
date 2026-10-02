// The app icon, everywhere it appears, from one drawing: the chief's faceted hexagon face.
//   node apps/web/scripts/gen-pwa-icons.mjs
// writes app/icon.svg (the master, also the browser tab icon), public/icons/*.png (home screen, notifications,
// the desktop window and tray) and apps/desktop/build/appx/*.png (the Windows Start menu, taskbar and tiles;
// without them the package ships electron-builder's sample logos). Rendered with sharp, which Next installs.
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";

const web = path.resolve(import.meta.dirname, "..");
const icons = path.join(web, "public", "icons");
const appx = path.resolve(web, "..", "desktop", "build", "appx");

// Geometry on a 512 grid. The hexagon's points sit 184px from the centre, inside the maskable safe zone (205px).
const C = [256, 256];
const T = [256, 72];
const TR = [404, 158];
const BR = [404, 354];
const B = [256, 440];
const BL = [108, 354];
const TL = [108, 158];
const HEX = `M${T} L${TR} L${BR} L${B} L${BL} L${TL}Z`;
const pts = (...ps) => ps.map((p) => p.join(",")).join(" ");

// Lit from the top right: each facet is a triangle from the centre to one edge.
const FACETS = [
  [T, TR, "#7ae8f8"],
  [TR, BR, "#36c4e6"],
  [BR, B, "#1d97be"],
  [B, BL, "#157fa3"],
  [BL, TL, "#27aed3"],
  [TL, T, "#5cdcf4"],
];
const INK = "#062631";
const EYES = [
  [194, 212],
  [280, 212],
];
const SMILE = "M204 318 Q256 362 308 318";

const defs = `<defs>
  <radialGradient id="bg" cx="50%" cy="42%" r="72%"><stop offset="0" stop-color="#10262e"/><stop offset=".55" stop-color="#0a1317"/><stop offset="1" stop-color="#06080a"/></radialGradient>
  <radialGradient id="glow" cx="256" cy="256" r="236" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#3fd3f2" stop-opacity=".38"/><stop offset=".55" stop-color="#3fd3f2" stop-opacity=".12"/><stop offset="1" stop-color="#3fd3f2" stop-opacity="0"/></radialGradient>
  <linearGradient id="bevel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".16"/><stop offset=".5" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity=".16"/></linearGradient>
  <mask id="cut"><path d="${HEX}" fill="#fff"/>${EYES.map(([x, y]) => `<rect x="${x}" y="${y}" width="38" height="58" rx="19" fill="#000"/>`).join("")}<path d="${SMILE}" fill="none" stroke="#000" stroke-width="20" stroke-linecap="round"/></mask>
</defs>`;

const face = [
  `<ellipse cx="180" cy="302" rx="15" ry="9" fill="#ff8fb1" opacity=".35"/><ellipse cx="332" cy="302" rx="15" ry="9" fill="#ff8fb1" opacity=".35"/>`,
  ...EYES.map(([x, y]) => `<rect x="${x}" y="${y}" width="38" height="58" rx="19" fill="${INK}"/><circle cx="${x + 25}" cy="${y + 17}" r="8" fill="#fff"/>`),
  `<path d="${SMILE}" fill="none" stroke="${INK}" stroke-width="17" stroke-linecap="round"/>`,
].join("");

// The hexagon face alone, in colour (taskbar, tray, tiles).
const chief = [
  FACETS.map(([a, b, fill]) => `<polygon points="${pts(a, b, C)}" fill="${fill}"/>`).join(""),
  // An inner bevel: a slightly smaller hexagon, lighter at the top and darker at the bottom.
  `<path d="${HEX}" transform="translate(256 256) scale(.86) translate(-256 -256)" fill="url(#bevel)"/>`,
  `<polyline points="${pts(TL, T, TR)}" fill="none" stroke="#d8fbff" stroke-opacity=".7" stroke-width="5" stroke-linejoin="round"/>`,
  face,
].join("");

const tile = (rounded) =>
  `<rect width="512" height="512"${rounded ? ' rx="112"' : ""} fill="url(#bg)"/><circle cx="256" cy="256" r="236" fill="url(#glow)"/><ellipse cx="256" cy="462" rx="110" ry="14" fill="#000" opacity=".35"/>${chief}`;
// Android's themed icon and notification badge use only the alpha: a white hexagon with the face cut out.
const silhouette = `<rect width="512" height="512" fill="#fff" mask="url(#cut)"/>`;

const svg = (body, { w = 512, h = 512, view = "0 0 512 512", label = false } = {}) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view}" width="${w}" height="${h}"${label ? ' role="img" aria-label="Chief"' : ""}>${defs}${body}</svg>`;
// The face centred in a wider or taller frame (for the Windows tiles), at `scale` of the frame's short side.
const framed = (w, h, scale) => {
  const side = (Math.min(w, h) * scale * 512) / 368; // the hexagon is 368 units tall
  const vw = (512 * w) / side;
  const vh = (512 * h) / side;
  return svg(chief, { w, h, view: `${256 - vw / 2} ${256 - vh / 2} ${vw} ${vh}` });
};

async function png(file, markup, size) {
  mkdirSync(path.dirname(file), { recursive: true });
  const image = sharp(Buffer.from(markup), { density: 144 });
  await (size ? image.resize(size, size) : image).png({ compressionLevel: 9 }).toFile(file);
  console.log(path.relative(path.resolve(web, "..", ".."), file));
}

writeFileSync(path.join(web, "app", "icon.svg"), svg(tile(true), { label: true }).replace(/ width="512" height="512"/, "") + "\n");

await png(path.join(icons, "icon-192.png"), svg(tile(true)), 192);
await png(path.join(icons, "icon-512.png"), svg(tile(true)), 512);
// Maskable and Apple icons are full-bleed: the launcher crops them, so no rounded corners of our own.
await png(path.join(icons, "maskable-512.png"), svg(tile(false)), 512);
await png(path.join(icons, "apple-touch-icon.png"), svg(tile(false)), 180);
await png(path.join(icons, "monochrome-512.png"), svg(silhouette), 512);
await png(path.join(icons, "badge-96.png"), svg(silhouette, { view: "88 56 336 400" }), 96);
// The desktop tray is 16px: the face alone reads there, a tile doesn't.
await png(path.join(icons, "tray-32.png"), svg(chief, { view: "88 56 336 400" }), 32);

// Windows: the unplated target sizes are what the taskbar and Start menu show; the rest are tiles and the Store.
for (const size of [16, 20, 24, 30, 32, 36, 40, 48, 60, 64, 72, 80, 96, 256]) {
  const markup = svg(chief, { view: "88 56 336 400" });
  await png(path.join(appx, `Square44x44Logo.targetsize-${size}.png`), markup, size);
  await png(path.join(appx, `Square44x44Logo.targetsize-${size}_altform-unplated.png`), markup, size);
  await png(path.join(appx, `Square44x44Logo.targetsize-${size}_altform-lightunplated.png`), markup, size);
}
await png(path.join(appx, "Square44x44Logo.png"), framed(44, 44, 0.86), 44);
await png(path.join(appx, "StoreLogo.png"), framed(50, 50, 0.8), 50);
await png(path.join(appx, "Square150x150Logo.png"), framed(150, 150, 0.56), 150);
await png(path.join(appx, "SmallTile.png"), framed(71, 71, 0.62), 71);
await png(path.join(appx, "LargeTile.png"), framed(310, 310, 0.5), 310);
const wide = path.join(appx, "Wide310x150Logo.png");
await sharp(Buffer.from(framed(310, 150, 0.62)), { density: 288 }).resize(310, 150).png({ compressionLevel: 9 }).toFile(wide);
console.log(path.relative(path.resolve(web, "..", ".."), wide));
