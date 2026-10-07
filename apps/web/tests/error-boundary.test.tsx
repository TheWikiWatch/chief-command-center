import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { SurfaceErrorBoundary } from "@/components/ui/error-boundary";

afterEach(cleanup);

function Broken({ explode }: { explode: boolean }) {
  if (explode) throw new Error("the vault index is corrupt");
  return <p>The vault</p>;
}

it("a crash in one surface shows that surface's error view, names it, and Try again brings the surface back", () => {
  const onError = vi.fn();
  const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
  let explode = true;
  const view = render(
    <SurfaceErrorBoundary name="vault" onError={onError}>
      <Broken explode={explode} />
    </SurfaceErrorBoundary>,
  );
  expect(screen.getByRole("alert")).toHaveTextContent("Something went wrong on this screen");
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "the vault index is corrupt" }), "vault");
  explode = false;
  view.rerender(
    <SurfaceErrorBoundary name="vault" onError={onError}>
      <Broken explode={explode} />
    </SurfaceErrorBoundary>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(screen.getByText("The vault")).toBeInTheDocument();
  expect(screen.queryByRole("alert")).toBeNull();
  quiet.mockRestore();
});
