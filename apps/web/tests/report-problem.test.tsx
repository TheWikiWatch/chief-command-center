import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { ReportProblemGroup, reportMail } from "@/components/settings/report-problem";

afterEach(cleanup);

const params = (url: string) => new URL(url.replace(/^mailto:/, "mailto://x/")).searchParams;

it("writes the e-mail: the tester's words, the versions and the file to attach", () => {
  const url = reportMail({
    to: "dev@example.com",
    what: "The chat froze after I sent a photo\nand never came back",
    expected: "The photo to show",
    versions: { app: "0.1.22", hermes: "2026.9.24" },
    device: "Desktop app on Windows",
    diagnostics: "chief-diagnostics-2026-10-03-15-12.zip",
    when: new Date("2026-10-03T15:12:00Z"),
  });
  expect(url.startsWith("mailto:dev@example.com?subject=")).toBe(true);
  const p = params(url);
  expect(p.get("subject")).toBe("Chief Command Center problem: The chat froze after I sent a photo…");
  const body = p.get("body") || "";
  expect(body).toContain("What happened:\nThe chat froze after I sent a photo\nand never came back");
  expect(body).toContain("What I expected:\nThe photo to show");
  expect(body).toContain("App 0.1.22 · Hermes 2026.9.24");
  expect(body).toContain("Desktop app on Windows · 2026-10-03 15:12 UTC");
  expect(body).toContain("Diagnostics: chief-diagnostics-2026-10-03-15-12.zip (in the Downloads folder; attach it to this e-mail)");
});

it("keeps a long report within what mail apps accept, and says when nothing is attached", () => {
  const body = params(reportMail({ to: "dev@example.com", what: "x".repeat(5000), versions: { app: "", hermes: "" }, device: "Phone" })).get("body") || "";
  expect(body).toContain("… (cut short)");
  expect(body.length).toBeLessThan(1700);
  expect(body).not.toContain("What I expected");
  expect(body).toContain("Diagnostics: not attached");
});

it("is hidden without a built-in address, and asks for what happened before it opens the e-mail", () => {
  const { container } = render(<ReportProblemGroup email="" versions={{ app: "1", hermes: "2" }} />);
  expect(container.innerHTML).toBe("");
  cleanup();
  render(<ReportProblemGroup email="dev@example.com" versions={{ app: "1", hermes: "2" }} />);
  const write = screen.getByRole("button", { name: "Write the e-mail" }) as HTMLButtonElement;
  expect(write.disabled).toBe(true);
  fireEvent.change(screen.getByPlaceholderText(/What you did/), { target: { value: "It broke" } });
  expect(write.disabled).toBe(false);
  expect(screen.getByText("To dev@example.com")).toBeTruthy();
});
