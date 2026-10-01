import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { Composer } from "@/components/chat/composer";

afterEach(cleanup);

function setup(working: boolean, text = "use the blue template") {
  const submit = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
  const onStop = vi.fn();
  const onSendAfter = vi.fn();
  render(
    <form onSubmit={submit}>
      <Composer
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
        working={working}
        onStop={onStop}
        onSendAfter={onSendAfter}
      />
    </form>,
  );
  return { submit, onStop, onSendAfter };
}

it("while the chief works: Enter adds to that work, Stop and Esc stop it, Alt+Enter sends after", () => {
  const { submit, onStop, onSendAfter } = setup(true);
  const field = screen.getByPlaceholderText("Add to what Chief is doing…");
  expect(screen.getByRole("button", { name: "Add to Chief's current work" })).toBeInTheDocument();
  fireEvent.keyDown(field, { key: "Enter" });
  expect(submit).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(field, { key: "Enter", altKey: true });
  expect(onSendAfter).toHaveBeenCalledTimes(1);
  expect(submit).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Send after Chief finishes" }));
  expect(onSendAfter).toHaveBeenCalledTimes(2);
  fireEvent.keyDown(field, { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "Stop Chief" }));
  expect(onStop).toHaveBeenCalledTimes(2);
});

it("Stop shows even with an empty draft; Send after needs a draft", () => {
  setup(true, "");
  expect(screen.getByRole("button", { name: "Stop Chief" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Send after Chief finishes" })).toBeNull();
});

it("when the chief is idle there is no Stop, Esc does nothing, and Alt+Enter just sends", () => {
  const { submit, onStop, onSendAfter } = setup(false);
  const field = screen.getByPlaceholderText("Message Chief");
  expect(screen.queryByRole("button", { name: "Stop Chief" })).toBeNull();
  fireEvent.keyDown(field, { key: "Escape" });
  expect(onStop).not.toHaveBeenCalled();
  fireEvent.keyDown(field, { key: "Enter", altKey: true });
  expect(onSendAfter).not.toHaveBeenCalled();
  expect(submit).toHaveBeenCalledTimes(1);
});
