import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef, useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { btn } from "@/components/ui/button";
import { Field, field } from "@/components/ui/field";
import { ViewSwitch } from "@/components/ui/controls";
import { useModal } from "@/lib/use-modal";

afterEach(() => cleanup());

function Dialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = useModal(ref, { inert: true });
  return (
    <div ref={ref} role="dialog" aria-modal="true" tabIndex={-1} onKeyDown={onKeyDown}>
      <button type="button" data-autofocus>
        First
      </button>
      <button type="button" onClick={onClose}>
        Last
      </button>
    </div>
  );
}

function Page() {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <main>
        <button type="button" onClick={() => setOpen(true)}>
          Open
        </button>
      </main>
      <div data-modal-keep aria-live="polite">
        toasts
      </div>
      {open ? <Dialog onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

describe("useModal", () => {
  it("moves focus in, keeps Tab inside, makes the page inert, and gives focus back", () => {
    render(<Page />);
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);
    const first = screen.getByRole("button", { name: "First" });
    const last = screen.getByRole("button", { name: "Last" });
    expect(document.activeElement).toBe(first);
    // The page behind is inert; the toast region stays reachable.
    expect(opener.closest("main")!.inert).toBe(true);
    expect((document.querySelector("[data-modal-keep]") as HTMLElement).inert).toBe(false);
    // Tab from the last control wraps to the first, Shift+Tab from the first to the last.
    last.focus();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab" });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
    act(() => last.click());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener.closest("main")!.inert).toBe(false);
    expect(document.activeElement).toBe(opener);
  });
});

describe("ViewSwitch", () => {
  it("is a radio group: one stop in the Tab order, arrow keys change the view and move focus", () => {
    function Example() {
      const [value, setValue] = useState<"ranked" | "attention">("ranked");
      return <ViewSwitch label="Order" value={value} onChange={setValue} options={[["ranked", "Ranked"], ["attention", "Attention"]]} />;
    }
    render(<Example />);
    const ranked = screen.getByRole("radio", { name: "Ranked" });
    const attention = screen.getByRole("radio", { name: "Attention" });
    expect(screen.getByRole("radiogroup", { name: "Order" })).toBeTruthy();
    expect(ranked.getAttribute("aria-checked")).toBe("true");
    expect([ranked.tabIndex, attention.tabIndex]).toEqual([0, -1]);
    ranked.focus();
    fireEvent.keyDown(ranked, { key: "ArrowRight" });
    expect(attention.getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(attention);
    fireEvent.keyDown(attention, { key: "Home" });
    expect(ranked.getAttribute("aria-checked")).toBe("true");
  });
});

describe("buttons and fields", () => {
  it("share one definition, with a visible focus ring on fields", () => {
    expect(btn("primary")).toContain("bg-fg");
    expect(btn("danger", "sm")).toContain("min-h-9");
    expect(field()).toContain("focus-visible:ring-2");
    expect(field({ mono: true })).toContain("font-mono");
  });

  it("wires a label, hint and error to the control", () => {
    render(
      <Field label="Update source" hint="A repository or a folder" error="Network shares aren't allowed">
        {(props) => <input {...props} />}
      </Field>,
    );
    const input = screen.getByLabelText("Update source");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const described = (input.getAttribute("aria-describedby") || "").split(" ");
    expect(described.map((id) => document.getElementById(id)?.textContent)).toEqual(["A repository or a folder", "Network shares aren't allowed"]);
  });
});
