/**
 * A face as a PNG, for the desktop app's update window (apps/desktop/src/main.ts readChiefLook → ChiefUpdater.exe).
 *
 * A face is SVG styled by the app's stylesheet (CSS variables, classes), which an SVG drawn into a canvas can't see,
 * so each element's computed paint is written onto it as inline style first. A photo face is drawn as is. Anything
 * that fails gives null and the window shows the app's icon instead.
 */

const PAINT = [
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-dasharray",
  "opacity",
  "display",
  "visibility",
  "transform",
  "transform-origin",
  "transform-box",
  "stop-color",
  "stop-opacity",
] as const;

/** The SVG with every element's computed paint inlined, sized `size` × `size`. */
export function inlinedSvg(svg: SVGSVGElement, size: number): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const from = [svg, ...Array.from(svg.querySelectorAll("*"))];
  const to = [clone, ...Array.from(clone.querySelectorAll("*"))];
  from.forEach((node, i) => {
    const target = to[i] as SVGElement | undefined;
    if (!target) return;
    const style = getComputedStyle(node);
    target.setAttribute("style", PAINT.map((p) => `${p}:${style.getPropertyValue(p)}`).filter((d) => !d.endsWith(":")).join(";"));
    target.removeAttribute("class");
  });
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  clone.setAttribute("width", String(size));
  clone.setAttribute("height", String(size));
  if (!clone.getAttribute("viewBox")) {
    const box = svg.getBoundingClientRect();
    clone.setAttribute("viewBox", `0 0 ${box.width || size} ${box.height || size}`);
  }
  return new XMLSerializer().serializeToString(clone);
}

function load(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image didn't load"));
    img.src = src;
  });
}

/** The face inside `root` (an SVG face or a photo) as a `data:image/png` URL, `size` px square; null on any failure. */
export async function faceSnapshot(root: Element | null, size = 224): Promise<string | null> {
  if (!root) return null;
  try {
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    const photo = root.querySelector("img");
    const svg = root.querySelector("svg");
    if (photo?.src) {
      const img = await load(photo.src);
      // Photo faces are rounded squares (22% corners), as the app draws them.
      const r = size * 0.22;
      ctx.beginPath();
      ctx.roundRect(0, 0, size, size, r);
      ctx.clip();
      ctx.drawImage(img, 0, 0, size, size);
    } else if (svg) {
      const url = URL.createObjectURL(new Blob([inlinedSvg(svg, size)], { type: "image/svg+xml" }));
      try {
        ctx.drawImage(await load(url), 0, 0, size, size);
      } finally {
        URL.revokeObjectURL(url);
      }
    } else return null;
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

/** Any CSS colour as `#rrggbb` (a canvas normalizes what it's given); "" when it isn't one. */
export function hexColor(color: string): string {
  try {
    const ctx = document.createElement("canvas").getContext("2d");
    if (!ctx) return "";
    ctx.fillStyle = "#000000";
    ctx.fillStyle = color;
    const out = String(ctx.fillStyle);
    return /^#[0-9a-f]{6}$/i.test(out) ? out : "";
  } catch {
    return "";
  }
}
