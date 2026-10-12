#!/usr/bin/env node
// `npm run check`: every check, in order, stopping at the first failure. Each step starts from a slim PATH
// (scripts/slim-env.mjs) so the nested npm runs inside them still find their tools on a PC with a long PATH.
import { spawnSync } from "node:child_process";
import path from "node:path";

import { slimEnv } from "./slim-env.mjs";

const repo = path.resolve(import.meta.dirname, "..");
const env = slimEnv();
const steps = [
  "npm --prefix apps/web run check",
  "npm --prefix apps/desktop run check",
  "npm run lint:python",
  "npm run test:python",
  "npm run privacy",
];

for (const step of steps) {
  const r = spawnSync(step, { cwd: repo, stdio: "inherit", shell: true, env });
  if (r.status !== 0) {
    console.error(`\n✗ ${step} failed (exit ${r.status}).`);
    process.exit(r.status || 1);
  }
}
