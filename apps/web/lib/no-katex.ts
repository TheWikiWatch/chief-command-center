/**
 * Stands in for `rehype-katex` (next.config.ts `turbopack.resolveAlias`). Streamdown imports KaTeX statically,
 * about 75 KB gzipped on every load, for math typesetting the chief's chat rarely needs. Without it, math
 * (`$x^2$`) is still recognised and shows as a code span. Remove the alias to typeset math again.
 */
export default function rehypeKatexOff() {
  return () => undefined;
}
