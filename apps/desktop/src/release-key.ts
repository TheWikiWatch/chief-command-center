import type { ReleaseKey } from "./updater";

/**
 * The Ed25519 public keys that may sign release.json (packaging/release/release-tool.mjs). An update whose
 * manifest doesn't verify against one of them is never downloaded or installed.
 *
 * Rotating the key: add the new key here (with its id) and ship that version signed with the OLD key; from the next
 * release on, sign with the new key (`--key-id`). Give the old key an `expires` date: a manifest published after it
 * no longer verifies with that key. Drop a key only once no supported version needs it.
 */
export const RELEASE_KEYS: ReleaseKey[] = [
  // The closed-phase key; replaced by the maintainer's offline release key before the first public release.
  { id: "closed-2026", publicKey: "MCowBQYDK2VwAyEA+sgsnSrF0e+OY/q6v/ESz4mRazvIbOx1sVneYcIRSq4=" },
];

/** The first key (what older code paths and tests pass as a single key). */
export const RELEASE_PUBLIC_KEY = RELEASE_KEYS[0].publicKey;
