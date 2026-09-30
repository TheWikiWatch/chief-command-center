import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { MessageMedia, mediaSrc, previewSrc, thumbSrc } from "@/components/message-media";

afterEach(cleanup);

const clip = {
  path: "E:\\Recordings\\Gaming\\clips\\demo\\clip.mp4",
  name: "clip.mp4",
  kind: "video" as const,
  mime: "video/mp4",
};

it("builds bridge urls for file, preview and thumb", () => {
  const enc = encodeURIComponent(clip.path);
  expect(mediaSrc(clip.path)).toBe(`/api/bridge/file?path=${enc}`);
  expect(previewSrc(clip.path)).toBe(`/api/bridge/preview?path=${enc}`);
  expect(thumbSrc(clip.path)).toBe(`/api/bridge/thumb?path=${enc}`);
  expect(mediaSrc("https://example.com/a.mp4")).toBe("https://example.com/a.mp4");
});

it("renders a video card with light-preview source, poster and full-quality link", () => {
  render(<MessageMedia attachments={[clip]} />);
  const video = document.querySelector("video") as HTMLVideoElement;
  expect(video).toBeTruthy();
  expect(video.getAttribute("src")).toBe(previewSrc(clip.path));
  expect(video.getAttribute("poster")).toBe(thumbSrc(clip.path));
  const full = screen.getByText("Full quality") as HTMLAnchorElement;
  expect(full.getAttribute("href")).toBe(mediaSrc(clip.path));
});

it("moves between a message's images in the lightbox", async () => {
  const images = ["a.png", "b.png"].map((name) => ({ path: `https://example.com/${name}`, name, kind: "image" as const, mime: "image/png" }));
  render(<MessageMedia attachments={images} />);
  fireEvent.click(screen.getByRole("button", { name: "Open a.png" }));
  expect(await screen.findByText("1 / 2")).toBeInTheDocument();
  fireEvent.keyDown(window, { key: "ArrowRight" });
  expect(await screen.findByText("2 / 2")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Next image" }));
  expect(await screen.findByText("1 / 2")).toBeInTheDocument();
});
