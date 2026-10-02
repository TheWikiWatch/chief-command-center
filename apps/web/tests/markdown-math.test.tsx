import { render } from "@testing-library/react";
import { Streamdown } from "streamdown";
import { expect, it } from "vitest";

it("keeps math readable when KaTeX is left out of the bundle", async () => {
  const view = render(<Streamdown>{"Inline $\pi r^2$ stays text.\n\n$$\nE = mc^2\n$$\n\nAfter the formula."}</Streamdown>);
  await view.findByText(/After the formula/);
  expect(view.container.textContent).toContain("\pi r^2");
  expect(view.container.textContent).toContain("E = mc^2");
  expect(view.container.querySelector(".katex")).toBeNull();
});
