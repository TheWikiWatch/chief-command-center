Chief Command Center - setup
============================

1. Unzip this folder anywhere (Downloads is fine). Don't run it from inside the zip.
2. Double-click "Install Chief.cmd".
   - It shows the certificate's fingerprint and asks for the first 8 characters of the fingerprint you
     were sent separately (by message, not in this folder). If they don't match, stop and ask the person
     who sent the folder.
   - If the PC has more than one drive with room, it asks which drive to install on (press Enter for the
     suggested one). Only the program goes there; your chats, notes and settings stay in your user folder.
   - If Windows SmartScreen says it protected your PC: click "More info", then "Run anyway".
   - The first time, Windows asks for administrator permission once. That lets it install apps signed
     with the certificate in this folder (chief-test-signing.cer). Nothing else on your PC is changed.
3. Chief opens. Follow its first-run screens (you'll need a key for at least one AI model provider).
4. Updates need no setup: new versions appear as an "Update available" card, and you choose when to
   install. (Only if you were sent an update key: Settings > Backup & updates > Update key.)

Running "Install Chief.cmd" again later is safe: it updates Chief in place and keeps your data.

Using Chief on your phone (optional)
------------------------------------
In Chief on the PC: Settings > Phone. It walks you through it and checks each step:
  1. Tailscale on the PC (free; the page links to it). Sign in.
  2. Turn on HTTPS certificates in Tailscale (the page opens the right Tailscale page).
  3. Click Turn on. Chief gets a private https:// address that only your account can open.
Then on the phone: install Tailscale, sign in with the same account, scan the QR code shown on the PC,
add Chief to the home screen, and in Chief on the phone open Settings > Phone > Turn on alerts.

To remove Chief: Settings > Apps > Installed apps > Chief Command Center > Uninstall.
