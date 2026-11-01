import { MessageId, ProviderInstanceId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { createFixtures, type DemoThread } from "./fixtures";
import { createReplayPlayer } from "./replay";

it.each([
  { provider: "codex", options: [{ id: "serviceTier", value: "fast" }], fast: true },
  { provider: "codex", options: [{ id: "serviceTier", value: "default" }], fast: false },
  { provider: "codex", options: [], fast: false },
  { provider: "claudeAgent", options: [{ id: "fastMode", value: true }], fast: true },
  { provider: "claudeAgent", options: [{ id: "fastMode", value: false }], fast: false },
  { provider: "cursor", options: [{ id: "fastMode", value: true }], fast: true },
  { provider: "cursor", options: [{ id: "fastMode", value: false }], fast: false },
])("streams reasoning and replies at the selected speed ($provider, Fast=$fast)", async (test) => {
  vi.useFakeTimers();
  let thread: DemoThread = {
    ...createFixtures()[0]!,
    continuation: {
      introduction: "Stream text",
      steps: [{ type: "reasoning", text: "thinking ".repeat(30).trim() }],
      answer: "reply ".repeat(30).trim(),
    },
  };
  const player = createReplayPlayer(
    () => thread,
    (next) => {
      thread = next;
      return { sequence: 1 };
    },
    0,
  );
  try {
    player.start(thread.id, "Go", MessageId.make("speed-message"), {
      instanceId: ProviderInstanceId.make(test.provider),
      model: thread.modelSelection.model,
      options: test.options,
    });
    await vi.advanceTimersByTimeAsync(250);
    expect(thread.items.at(-1)).toMatchObject({ type: "reasoning", text: "" });
    await vi.advanceTimersByTimeAsync(220);
    const wordCount = test.fast ? 15 : 10;
    expect(thread.items.at(-1)).toMatchObject({
      type: "reasoning",
      text: "thinking ".repeat(wordCount),
      streaming: true,
    });
    await vi.advanceTimersByTimeAsync((test.fast ? 440 : 660) - 220 + 550);
    expect(thread.items.at(-1)).toMatchObject({ type: "assistant_message", text: "" });
    await vi.advanceTimersByTimeAsync(220);
    expect(thread.items.at(-1)).toMatchObject({
      type: "assistant_message",
      text: "reply ".repeat(wordCount),
      streaming: true,
    });
  } finally {
    player.dispose();
    vi.useRealTimers();
  }
});
