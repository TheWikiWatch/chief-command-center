// MSIX packaging (PLAN Phase 8). Self-signed while the repo is closed; SignPath Foundation later (Phase 12).
//
//   CHIEF_PAYLOAD_DIR     built Hermes payload (packaging/payload/stage.py); its offline uv cache is left out
//   CHIEF_RELEASE_DIR     output folder (default: ../../release)
//   CHIEF_SIGN_PFX        test signing certificate (.pfx; never in the repo)
//   CHIEF_SIGN_PASSWORD   its password
//   CHIEF_PUBLISHER       the certificate's subject, e.g. "CN=Chief Command Center Test"
//   CHIEF_UPDATE_FEED     optional: the update source the build carries (github:owner/repo), so a new install
//                         checks the releases repository without being told (scripts/release.mjs sets it)
//
// The payload, the dashboard's standalone server, the bundled plugins and the backup engine go under
// resources/, where the shell finds them (src/paths.ts).
const path = require("node:path");

const repo = path.resolve(__dirname, "..", "..");
const payload = process.env.CHIEF_PAYLOAD_DIR;
if (!payload) throw new Error("Set CHIEF_PAYLOAD_DIR to a built Hermes payload.");
const publisher = process.env.CHIEF_PUBLISHER || "CN=Chief Command Center Test";

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "org.chiefcommandcenter.desktop",
  productName: "Chief Command Center",
  copyright: "Chief Command Center contributors (MIT)",
  directories: { output: process.env.CHIEF_RELEASE_DIR || path.join(repo, "release"), buildResources: "build" },
  files: ["dist/**/*", "static/**/*", "package.json"],
  asar: true,
  // Electron fuses, flipped in the binary before signing. The dashboard server runs under utilityProcess,
  // which doesn't need RunAsNode; nothing loads the app from outside app.asar, and the boot page is the
  // only file:// page (it fetches nothing). ASAR integrity covers app.asar; the payload and web server
  // under resources/ are protected by the MSIX install folder (read-only, ACL'd). With file:// privileges off a
// file:// page can't read inside app.asar, so the boot page is served under its own scheme (src/boot-protocol.ts).
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
  },
  // Read by src/release-source.ts builtInFeed().
  ...(process.env.CHIEF_UPDATE_FEED ? { extraMetadata: { chiefUpdateFeed: process.env.CHIEF_UPDATE_FEED } } : {}),
  extraResources: [
    // Left out: the offline uv cache, bytecode caches, the builder's lock and its leftover .build-* work folders.
    { from: payload, to: "payload", filter: ["**/*", "!uv-cache/**", "!**/__pycache__/**", "!payload.prepare.lock", "!.build-*/**"] },
    // electron-builder silently skips dot-folders and node_modules inside a resource folder, so the
    // standalone server's own `.next` and `node_modules` are listed explicitly.
    { from: path.join(repo, "apps", "web", ".next", "standalone"), to: "web", filter: ["**/*"] },
    { from: path.join(repo, "apps", "web", ".next", "standalone", ".next"), to: "web/.next", filter: ["**/*"] },
    { from: path.join(repo, "apps", "web", ".next", "standalone", "node_modules"), to: "web/node_modules", filter: ["**/*"] },
    { from: path.join(repo, "hermes", "plugins"), to: "plugins", filter: ["**/*", "!**/__pycache__/**", "!**/.token"] },
    // The vendored Second Brain toolkit (MIT); provisioning installs it from <resources>/vendor.
    { from: path.join(repo, "hermes", "vendor"), to: "vendor", filter: ["**/*", "!**/__pycache__/**"] },
    { from: path.join(repo, "backup", "chief_backup"), to: "backup/chief_backup", filter: ["**/*.py"] },
    { from: path.join(__dirname, "python"), to: "python", filter: ["*.py"] },
    { from: path.join(repo, "apps", "web", "public", "icons", "icon-512.png"), to: "icon.png" },
    { from: path.join(repo, "LICENSE"), to: "LICENSE" },
  ],
  win: {
    target: [{ target: "appx", arch: ["x64"] }],
    icon: path.join(repo, "apps", "web", "public", "icons", "icon-512.png"),
    ...(process.env.CHIEF_SIGN_PFX
      ? { cscLink: process.env.CHIEF_SIGN_PFX, cscKeyPassword: process.env.CHIEF_SIGN_PASSWORD, signtoolOptions: { sign: path.join(__dirname, "build", "sign.cjs") } }
      : {}),
  },
  appx: {
    identityName: "ChiefCommandCenter",
    applicationId: "ChiefCommandCenter",
    displayName: "Chief Command Center",
    publisher,
    publisherDisplayName: "Chief Command Center contributors",
    backgroundColor: "#0c0d10",
    languages: ["en-US"],
    minVersion: "10.0.19041.0",
    addAutoLaunchExtension: false,
    customManifestPath: path.join(__dirname, "build", "appxmanifest.xml"),
  },
};
