import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { Composer } from "@/components/chat/composer";

afterEach(cleanup);

function setup(phone: boolean) {
  const submit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
  const onAddFiles = vi.fn();
  render(
    <form onSubmit={submit}>
      <Composer
        phone={phone}
        text="hello"
        onText={vi.fn()}
        pendingFiles={[]}
        onAddFiles={onAddFiles}
        onRemoveFile={vi.fn()}
        connected
        busy={false}
        micStatus={{ state: "idle", cancelling: false }}
        onMicStatus={vi.fn()}
        onTranscript={vi.fn(async () => undefined)}
        onMicError={vi.fn()}
      />
    </form>,
  );
  return { submit, onAddFiles, field: screen.getByPlaceholderText("Message Chief") };
}

it("sends on Enter on desktop, but not while an input method is composing", () => {
  const { submit, field } = setup(false);
  fireEvent.keyDown(field, { key: "Enter", isComposing: true });
  expect(submit).not.toHaveBeenCalled();
  fireEvent.keyDown(field, { key: "Enter" });
  expect(submit).toHaveBeenCalledTimes(1);
});

it("adds a line on Enter on the phone; the arrow (or Ctrl+Enter) sends", () => {
  const { submit, field } = setup(true);
  fireEvent.keyDown(field, { key: "Enter" });
  expect(submit).not.toHaveBeenCalled();
  fireEvent.keyDown(field, { key: "Enter", ctrlKey: true });
  expect(submit).toHaveBeenCalledTimes(1);
});

it("turns a pasted screenshot into an attachment", () => {
  const { onAddFiles, field } = setup(false);
  const file = new File(["png"], "shot.png", { type: "image/png" });
  fireEvent.paste(field, { clipboardData: { files: [file], getData: () => "" } });
  expect(onAddFiles).toHaveBeenCalledWith([file]);
});
