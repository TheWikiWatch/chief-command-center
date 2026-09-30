/**
 * The Ed25519 public key that signs release.json (packaging/release/release-tool.mjs). An update whose
 * manifest doesn't verify against this key is never downloaded or installed.
 *
 * This is the closed-phase key; it is replaced by the maintainer's offline release key before the first
 * public release (Phase 12).
 */
export const RELEASE_PUBLIC_KEY = "MCowBQYDK2VwAyEA+sgsnSrF0e+OY/q6v/ESz4mRazvIbOx1sVneYcIRSq4=";
