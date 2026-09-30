/** Server start-up: the weekly backup schedule (it does nothing until the owner chooses a backup folder). */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startScheduler } = await import("@/lib/server/backup");
    startScheduler();
  }
}
