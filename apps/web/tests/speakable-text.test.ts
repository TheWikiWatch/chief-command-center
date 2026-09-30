import { expect, it } from "vitest";

import { speakableText } from "@/lib/voice-client";

it("reads links by their words, bare URLs as 'link', and paths by file name", () => {
  const reply = String.raw`Saved to E:\Second Brain\wiki\Launch Plan.md and the [pricing page](https://example.com/p). Logs: https://example.com/x?y=1 in C:\Users\me\logs`;
  expect(speakableText(reply)).toBe("Saved to Launch Plan and the pricing page. Logs: link in a folder");
});

it("says wikilinks by name or alias and drops custom emoji codes", () => {
  expect(speakableText("See [[wiki/Concrete Candles#Pricing]] and [[Weekly|the review]] <:pepe:123456> done")).toBe(
    "See Concrete Candles and the review done",
  );
});

it("still strips code and markup", () => {
  expect(speakableText("**Done.**\n\n```\nnpm test\n```\n`x` > y")).toBe("Done. x y");
});
