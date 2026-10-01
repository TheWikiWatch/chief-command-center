import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { Composer } from "@/components/chat/composer";

afterEach(cleanup);

const box = (text: string, more: Partial<Parameters<typeof Composer>[0]> = {}) =>
  render(
    <Composer
      phone={false}
      text={text}
      onText={vi.fn()}
      pendingFiles={[]}
      onAddFiles={vi.fn()}
      onRemoveFile={vi.fn()}
      connected
      busy={false}
      micStatus={{ state: "idle", cancelling: false }}
      onMicStatus={vi.fn()}
      onTranscript={vi.fn(async () => undefined)}
      onMicError={vi.fn()}
      {...more}
    />,
  );

it("draws the hint on one line over the box, never as the box's own placeholder", () => {
  const { container } = box("", { working: true });
  const field = screen.getByRole("textbox", { name: "Add to what Nova is doing…" });
  expect(field).not.toHaveAttribute("placeholder"); // a wrapped placeholder used to push the box to two lines
  expect(field).toHaveAttribute("title", "Add to what Nova is doing…"); // the whole hint on hover when shortened
  const hint = container.querySelector(".composer-hint");
  expect(hint).toHaveTextContent("Add to what Nova is doing…");
  expect(hint).toHaveClass("truncate", "leading-6", "py-3", "px-1.5"); // same line box and padding as the field
  expect(hint).toHaveAttribute("aria-hidden", "true");
});

it("hides the hint as soon as there is text", () => {
  const { container } = box("hello");
  expect(container.querySelector(".composer-hint")).toBeNull();
  expect(screen.getByRole("textbox", { name: "Message Nova" })).not.toHaveAttribute("title");
});
