import { expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import { RpcSchema } from "effect/rpc";
import * as Exit from "effect/Exit";
import {
  CommandId,
  WsRpcGroup,
  MessageId,
  ProviderInstanceId,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ShellSnapshot,
  ThreadId,
  WS_METHODS,
  ORCHESTRATION_V2_WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { createDemoEnvironment, DEMO_THREAD_ID, demoConfig } from "./environment";
import { projects, projectionOf } from "./fixtures";
import { isProviderInstancePickerReady, providerInstanceEntriesFor } from "../providerInstances";
import {
  deriveThreadQueueWorkflowState,
  threadSupportsProviderHandoff,
} from "@t3tools/client-runtime/state/thread-workflows";
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import { scenarios } from "./scenarios";
import { getComposerReasoningStep } from "../components/chat/composerProviderState";
import { getTraitsSectionVisibility } from "../components/chat/TraitsPicker";
import { buildTraitsTriggerDisplay } from "@t3tools/client-runtime/model-traits";

const isProjection = Schema.is(OrchestrationV2ThreadProjection);
const isShell = Schema.is(OrchestrationV2ShellSnapshot);
const validators = new Map(
  [...WsRpcGroup.requests].map(([method, rpc]) => [
    method,
    Schema.is(
      RpcSchema.isStreamSchema(rpc.successSchema) ? rpc.successSchema.success : rpc.successSchema,
    ),
  ]),
);

it.effect("launches an independent thread and completes a replay with tools and a diff", () =>
  Effect.gen(function* () {
    vi.useFakeTimers();
    const environment = createDemoEnvironment(1);
    try {
      expect(demoConfig.providers.map((provider) => provider.driver)).toEqual([
        "codex",
        "claudeAgent",
        "cursor",
        "grok",
        "opencode",
        "antigravity",
        "muse",
        "pi",
      ]);
      for (const projectId of [null, ...projects.map((project) => project.id)]) {
        const selectable = providerInstanceEntriesFor(
          demoConfig.providers,
          demoConfig.settings,
          projectId,
        ).filter(isProviderInstancePickerReady);
        expect(selectable.map((entry) => entry.instanceId)).toEqual(
          demoConfig.providers.map((provider) => provider.instanceId),
        );
      }
      for (const provider of demoConfig.providers) {
        for (const model of provider.models) {
          const supportsSpeed = ["codex", "claudeAgent", "cursor"].includes(provider.driver);
          const input = {
            provider: provider.driver,
            models: provider.models,
            model: model.slug,
            planModeEnabled: true,
          };
          const standard = getTraitsSectionVisibility(input);
          expect(
            standard.fastModeDescriptor !== null ||
              standard.selectDescriptors.some((descriptor) => descriptor.id === "serviceTier"),
            `${provider.displayName}: ${model.name} speed control`,
          ).toBe(supportsSpeed);
          const speed = {
            id: provider.driver === "codex" ? "serviceTier" : "fastMode",
            value: provider.driver === "codex" ? "fast" : true,
          };
          for (const fast of supportsSpeed ? [false, true] : [false]) {
            const traits = getTraitsSectionVisibility({
              ...input,
              modelOptions: fast ? [speed] : undefined,
            });
            expect(
              buildTraitsTriggerDisplay({
                provider: provider.driver,
                descriptors: traits.descriptors,
                primarySelectDescriptorId: traits.primarySelectDescriptor?.id ?? null,
                ultrathinkPromptControlled: false,
              }).speedLabel,
            ).toBe(fast ? "Fast" : null);
          }
          expect(
            getComposerReasoningStep({
              provider: provider.driver,
              instanceId: provider.instanceId,
              model: model.slug,
              models: provider.models,
              modelOptions: undefined,
              prompt: "Fix the search",
              cursor: 0,
              planModeEnabled: true,
              direction: 1,
            })?.modelOptions,
            `${provider.displayName}: ${model.name}`,
          ).toEqual(expect.arrayContaining([{ id: "reasoningEffort", value: "xhigh" }]));
        }
      }
      const seeded = environment.getThread(DEMO_THREAD_ID).items;
      expect(
        threadSupportsProviderHandoff(projectionOf(environment.getThread(DEMO_THREAD_ID))),
      ).toBe(true);
      expect(seeded.findIndex((item) => item.type === "file_change")).toBeLessThan(
        seeded.findIndex((item) => item.type === "assistant_message"),
      );
      const id = ThreadId.make("visitor-thread");
      const result = yield* environment.launch({
        commandId: CommandId.make("launch-1"),
        threadId: id,
        projectId: projects[1]!.id,
        title: "Find the bug",
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-fable-5.5",
          options: [{ id: "fastMode", value: true }],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: {
          messageId: MessageId.make("visitor-message"),
          text: "Fix the search",
          attachments: [],
        },
      });
      expect(result.threadId).toBe(id);
      expect(result.projection.runs.at(-1)?.status).toBe("running");
      expect(
        result.projection.turnItems.find((item) => item.type === "user_message")?.startedAt,
      ).toBe(result.projection.runs.at(-1)?.startedAt);
      expect(
        environment.snapshot().threads.find((thread) => thread.id === id)?.activeRunId,
      ).toBeTruthy();
      yield* Effect.promise(() => vi.runAllTimersAsync());
      const completed = environment.getThread(id);
      expect(completed.runs.at(-1)?.status).toBe("completed");
      const responseIndex = completed.items.findIndex((item) => item.type === "assistant_message");
      expect(completed.items.findIndex((item) => item.type === "command_execution")).toBeLessThan(
        responseIndex,
      );
      expect(completed.items.findIndex((item) => item.type === "file_change")).toBeLessThan(
        responseIndex,
      );
      expect(completed.items.map((item) => item.ordinal)).toEqual(
        completed.items.map((item) => item.ordinal).toSorted((a, b) => a - b),
      );
      expect(
        completed.items.some((item) => item.type === "command_execution" && item.exitCode === 0),
      ).toBe(true);
      expect(
        completed.items.some(
          (item) => item.type === "file_change" && item.fileName === "src/search.ts",
        ),
      ).toBe(true);
      expect(completed.items.find((item) => item.type === "assistant_message")?.text).toContain(
        "deduplicating",
      );
      expect(isProjection(projectionOf(completed))).toBe(true);
      expect(isShell(environment.snapshot())).toBe(true);
      expect(completed.runs.at(-1)?.providerInstanceId).toBe("claudeAgent");
      expect(completed.runs.at(-1)?.modelSelection.options).toEqual([
        { id: "fastMode", value: true },
      ]);
      yield* environment.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("cycle-follow-up"),
        threadId: id,
        messageId: MessageId.make("follow-up"),
        text: "Continue",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "start_immediately" },
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "gpt-6.2-terra",
          options: [{ id: "reasoningEffort", value: "max" }],
        },
      });
      yield* Effect.promise(() => vi.runAllTimersAsync());
      const followUp = environment.getThread(id);
      expect(followUp.runs.at(-1)?.providerInstanceId).toBe("opencode");
      expect(followUp.runs.at(-1)?.modelSelection.options).toEqual([
        { id: "reasoningEffort", value: "max" },
      ]);
      expect(followUp.runs[0]?.modelSelection).toEqual(completed.runs[0]?.modelSelection);
      expect(threadSupportsProviderHandoff(projectionOf(followUp))).toBe(true);
      expect(
        followUp.items.filter((item) => item.type === "assistant_message").at(-1)?.text,
      ).toContain("older save");
      yield* environment.dispatch({
        type: "provider.switch",
        commandId: CommandId.make("change-model"),
        threadId: id,
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-opus-5.7",
        },
      });
      expect(environment.getThread(id).modelSelection.instanceId).toBe("claudeAgent");
      expect(environment.getThread(id).items).toEqual(followUp.items);
      const diff = yield* environment.session.client[ORCHESTRATION_V2_WS_METHODS.getTurnDiff]({
        threadId: id,
        fromTurnCount: 0,
        toTurnCount: 1,
      });
      expect(diff.diff).toContain("src/search.ts");
      expect(diff.diff).not.toContain("src/autosave.ts");
      const nextDiff = yield* environment.session.client[ORCHESTRATION_V2_WS_METHODS.getTurnDiff]({
        threadId: id,
        fromTurnCount: 1,
        toTurnCount: 2,
      });
      expect(nextDiff.diff).toContain("src/autosave.ts");
    } finally {
      environment.dispose();
      vi.useRealTimers();
    }
  }),
);

it.effect("cancels replay without late updates and accepts a follow-up", () =>
  Effect.gen(function* () {
    vi.useFakeTimers();
    const environment = createDemoEnvironment();
    const dispatch = (type: string) =>
      environment.dispatch({
        type,
        commandId: CommandId.make(type),
        threadId: DEMO_THREAD_ID,
        ...(type === "message.dispatch"
          ? {
              messageId: MessageId.make(`message-${environment.snapshot().snapshotSequence}`),
              createdBy: "user",
              creationSource: "web",
              text: "Please continue",
              attachments: [],
              dispatchMode: { type: "start_immediately" },
            }
          : {}),
      });
    try {
      yield* dispatch("message.dispatch");
      yield* Effect.promise(() => vi.advanceTimersByTimeAsync(250));
      const running = environment.getThread(DEMO_THREAD_ID);
      expect(running.items.at(-1)?.type).toBe("reasoning");
      expect(running.items.at(-1)?.status).toBe("running");
      yield* dispatch("thread.stop");
      const sequence = environment.snapshot().snapshotSequence;
      yield* Effect.promise(() => vi.runAllTimersAsync());
      expect(environment.snapshot().snapshotSequence).toBe(sequence);
      expect(environment.getThread(DEMO_THREAD_ID).runs.at(-1)?.status).toBe("interrupted");
      yield* dispatch("message.dispatch");
      yield* Effect.promise(() => vi.runAllTimersAsync());
      expect(environment.getThread(DEMO_THREAD_ID).runs.at(-1)?.status).toBe("completed");
    } finally {
      environment.dispose();
      vi.useRealTimers();
    }
  }),
);

it.effect("publishes authoritative lifecycle changes and keeps visits independent", () =>
  Effect.gen(function* () {
    const environment = createDemoEnvironment();
    const independent = createDemoEnvironment();
    const dispatch = (input: Record<string, unknown>) =>
      environment.dispatch({
        commandId: CommandId.make("lifecycle"),
        threadId: DEMO_THREAD_ID,
        ...input,
      });
    try {
      yield* dispatch({ type: "thread.metadata.update", title: "A different title" });
      const beforeVisit = environment.getThread(DEMO_THREAD_ID).metadata?.updatedAt;
      yield* dispatch({ type: "thread.visit", visitedAt: "2026-10-28T10:00:00.000Z" });
      expect(environment.getThread(DEMO_THREAD_ID).metadata?.updatedAt).toBe(beforeVisit);
      const receipt = yield* dispatch({ type: "thread.settle" });
      expect(environment.snapshot().snapshotSequence).toBe(receipt.sequence);
      expect(
        environment.snapshot().threads.find((thread) => thread.id === DEMO_THREAD_ID)
          ?.settledOverride,
      ).toBe("settled");
      yield* dispatch({ type: "thread.unsettle", reason: "user" });
      expect(
        environment.snapshot().threads.find((thread) => thread.id === DEMO_THREAD_ID)
          ?.settledOverride,
      ).toBe("active");
      yield* dispatch({ type: "thread.archive" });
      expect(environment.snapshot().threads.some((thread) => thread.id === DEMO_THREAD_ID)).toBe(
        false,
      );
      yield* dispatch({ type: "thread.unarchive" });
      expect(environment.snapshot().threads.some((thread) => thread.id === DEMO_THREAD_ID)).toBe(
        true,
      );
      yield* dispatch({ type: "thread.delete" });
      expect(environment.snapshot().threads.some((thread) => thread.id === DEMO_THREAD_ID)).toBe(
        false,
      );
      expect(independent.getThread(DEMO_THREAD_ID).title).toBe("Add a command menu");
    } finally {
      environment.dispose();
      independent.dispose();
    }
  }),
);

it.effect("cycles through every scenario, preserves continuations, and wraps to the first", () =>
  Effect.gen(function* () {
    vi.useFakeTimers();
    const environment = createDemoEnvironment();
    try {
      for (const scenario of scenarios) {
        const dispatch = (input: Record<string, unknown>) =>
          environment.dispatch({
            commandId: CommandId.make(`scenario-${scenario.id}`),
            threadId: DEMO_THREAD_ID,
            ...input,
          });
        const send = () =>
          dispatch({
            type: "message.dispatch",
            messageId: MessageId.make(`message-${scenario.id}`),
            text: "Explore this scenario",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            dispatchMode: { type: "start_immediately" },
          });
        const observed = yield* environment.session.client[
          ORCHESTRATION_V2_WS_METHODS.subscribeThread
        ]({ threadId: DEMO_THREAD_ID }).pipe(
          Stream.tap((event) =>
            event.kind === "synchronized"
              ? Effect.gen(function* () {
                  yield* send();
                  yield* Effect.promise(() => vi.runAllTimersAsync());
                  const waiting = projectionOf(environment.getThread(DEMO_THREAD_ID));
                  expect(isProjection(waiting), scenario.id).toBe(true);
                  expect(isShell(environment.snapshot()), scenario.id).toBe(true);
                  const requests = derivePendingThreadRequests(waiting);
                  expect(requests.approvals).toEqual([]);
                  for (const question of requests.userInputs) {
                    expect(question.responseCapability).toBe("live");
                    const invalid = yield* Effect.exit(
                      dispatch({
                        type: "runtime-request.respond",
                        requestId: question.requestId,
                        answers: {},
                      }),
                    );
                    expect(Exit.isFailure(invalid)).toBe(true);
                    yield* dispatch({
                      type: "runtime-request.respond",
                      requestId: question.requestId,
                      answers: { "test-focus": "Editor interactions" },
                    });
                  }
                  yield* Effect.promise(() => vi.runAllTimersAsync());
                })
              : Effect.void,
          ),
          Stream.takeUntil(
            (event) =>
              event.kind === "snapshot" &&
              event.projection.runs.some(
                (run) =>
                  run.userMessageId === `message-${scenario.id}` && run.status === "completed",
              ),
          ),
          Stream.filter((event) => event.kind === "snapshot"),
          Stream.map((event) => event.projection),
          Stream.runCollect,
        );
        const completed = environment.getThread(DEMO_THREAD_ID);
        expect(completed.items.at(-1)).toMatchObject({
          text: expect.stringContaining(scenario.answer),
        });
        expect(observed.every(isProjection), scenario.id).toBe(true);
        if (scenario.id === "feature") {
          const plans = observed.flatMap((projection) =>
            projection.turnItems.filter(
              (item) => item.runId === completed.runs.at(-1)?.id && item.type === "todo_list",
            ),
          );
          expect(
            plans.some(
              (item) =>
                item.type === "todo_list" && item.steps.some((step) => step.status === "running"),
            ),
          ).toBe(true);
          expect(plans.at(-1)).toMatchObject({
            steps: [{ status: "completed" }, { status: "completed" }, { status: "completed" }],
          });
          expect(new Set(plans.map((item) => item.id)).size).toBe(1);
          expect(
            observed.some((projection) =>
              projection.turnItems.some(
                (item) => item.type === "dynamic_tool" && item.status === "running",
              ),
            ),
          ).toBe(true);
          expect(
            observed.some((projection) =>
              projection.turnItems.some(
                (item) => item.type === "reasoning" && item.streaming && item.text.length > 0,
              ),
            ),
          ).toBe(true);
        }
        expect(completed.runs.at(-1)?.status, scenario.id).toBe("completed");
        expect(completed.items.at(-1)?.type).toBe("assistant_message");
        expect(isProjection(projectionOf(completed)), scenario.id).toBe(true);
        expect(completed.requests?.every((request) => request.status !== "pending") ?? true).toBe(
          true,
        );
        if (scenario.id === "question") {
          expect(completed.items.at(-1)).toMatchObject({
            text: expect.stringContaining("Editor interactions"),
          });
        }
        if (scenario.id === "test-repair") {
          expect(
            completed.items
              .filter(
                (item) =>
                  item.runId === completed.runs.at(-1)?.id && item.type === "command_execution",
              )
              .map((item) => item.status),
          ).toEqual(["failed", "completed"]);
        }
        if (scenario.next) {
          yield* send();
          yield* Effect.promise(() => vi.runAllTimersAsync());
          const continued = environment.getThread(DEMO_THREAD_ID);
          expect(continued.items.at(-1)).toMatchObject({
            text: expect.stringContaining("previous turn"),
          });
          expect(continued.continuation).toBeUndefined();
        }
      }
      yield* environment.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("cycle-wrap"),
        threadId: DEMO_THREAD_ID,
        messageId: MessageId.make("cycle-wrap"),
        text: "Continue",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "start_immediately" },
      });
      yield* Effect.promise(() => vi.runAllTimersAsync());
      expect(environment.getThread(DEMO_THREAD_ID).items.at(-1)).toMatchObject({
        text: scenarios[0]!.answer,
      });
    } finally {
      environment.dispose();
      vi.useRealTimers();
    }
  }),
);

it.effect("cancels pending questions without resuming stale work", () =>
  Effect.gen(function* () {
    vi.useFakeTimers();
    const index = scenarios.findIndex((scenario) => scenario.id === "question");
    const environment = createDemoEnvironment(index);
    const dispatch = (input: Record<string, unknown>) =>
      environment.dispatch({
        commandId: CommandId.make("question-lifecycle"),
        threadId: DEMO_THREAD_ID,
        ...input,
      });
    const send = () =>
      dispatch({
        type: "message.dispatch",
        messageId: MessageId.make("question-message"),
        text: "Go",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: "start_immediately" },
      });
    try {
      yield* send();
      yield* Effect.promise(() => vi.runAllTimersAsync());
      const first = environment.getThread(DEMO_THREAD_ID).requests!.at(-1)!;
      expect(
        environment.snapshot().threads.find((thread) => thread.id === DEMO_THREAD_ID)
          ?.pendingRuntimeRequest?.id,
      ).toBe(first.id);
      yield* dispatch({ type: "thread.stop" });
      const stopped = environment.snapshot().snapshotSequence;
      const stale = yield* Effect.exit(
        dispatch({
          type: "runtime-request.respond",
          requestId: first.id,
          answers: { "test-focus": "Editor interactions" },
        }),
      );
      expect(Exit.isFailure(stale)).toBe(true);
      yield* Effect.promise(() => vi.runAllTimersAsync());
      expect(environment.snapshot().snapshotSequence).toBe(stopped);
      expect(environment.getThread(DEMO_THREAD_ID).requests!.at(-1)?.status).toBe("cancelled");
      expect(environment.getThread(DEMO_THREAD_ID).runs.at(-1)?.status).toBe("interrupted");
      yield* send();
      yield* Effect.promise(() => vi.runAllTimersAsync());
      expect(environment.getThread(DEMO_THREAD_ID).runs.at(-1)?.status).toBe("completed");
    } finally {
      environment.dispose();
      vi.useRealTimers();
    }
  }),
);

it.effect("serves files and diffs locally and rejects unsupported execution immediately", () =>
  Effect.gen(function* () {
    const environment = createDemoEnvironment();
    try {
      const client = environment.session.client;
      const contents = yield* client[WS_METHODS.projectsReadFile]({
        cwd: "/workspace/orbit",
        relativePath: "README.md",
      });
      expect(contents.contents).toContain("fictional workspace");
      const diff = yield* client[ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff]({
        threadId: DEMO_THREAD_ID,
        toTurnCount: 1,
      });
      expect(diff.diff).toContain("diff --git");
      const unsupported = yield* Effect.exit(
        client[WS_METHODS.vcsPull]({ cwd: "/workspace/orbit" }),
      );
      expect(Exit.isFailure(unsupported)).toBe(true);
      const initial = yield* Stream.runHead(client[ORCHESTRATION_V2_WS_METHODS.subscribeShell]({}));
      expect(initial._tag).toBe("Some");
    } finally {
      environment.dispose();
    }
  }),
);

it.effect(
  "edits, reorders, and cancels queued messages before playing scenarios in delivery order",
  () =>
    Effect.gen(function* () {
      vi.useFakeTimers();
      const environment = createDemoEnvironment();
      const dispatch = (input: Record<string, unknown>) =>
        environment.dispatch({
          commandId: CommandId.make("queue-controls"),
          threadId: DEMO_THREAD_ID,
          ...input,
        });
      const send = (id: string, queued = true) =>
        dispatch({
          type: "message.dispatch",
          messageId: MessageId.make(id),
          text: id,
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          dispatchMode: { type: queued ? "queue_after_active" : "start_immediately" },
        });
      try {
        yield* send("active", false);
        const activeId = environment.getThread(DEMO_THREAD_ID).runs.at(-1)!.id;
        yield* send("first");
        yield* send("second");
        yield* send("cancelled");
        const queued = deriveThreadQueueWorkflowState(
          projectionOf(environment.getThread(DEMO_THREAD_ID)),
        );
        expect(queued.activeRun?.id).toBe(activeId);
        expect(queued.canPromoteToSteer).toBe(true);
        expect(queued.queuedRuns.map((run) => run.text)).toEqual(["first", "second", "cancelled"]);
        expect(isProjection(projectionOf(environment.getThread(DEMO_THREAD_ID)))).toBe(true);
        expect(isShell(environment.snapshot())).toBe(true);
        yield* dispatch({
          type: "queued-run.edit",
          runId: queued.queuedRuns[1]!.run.id,
          text: "edited second",
        });
        yield* dispatch({
          type: "queued-run.reorder",
          runId: queued.queuedRuns[1]!.run.id,
          beforeRunId: queued.queuedRuns[0]!.run.id,
        });
        yield* dispatch({ type: "queued-run.cancel", runId: queued.queuedRuns[2]!.run.id });
        expect(
          projectionOf(environment.getThread(DEMO_THREAD_ID)).messages.some(
            (message) => message.id === "cancelled",
          ),
        ).toBe(true);
        expect(
          deriveThreadQueueWorkflowState(
            projectionOf(environment.getThread(DEMO_THREAD_ID)),
          ).queuedRuns.map((run) => run.text),
        ).toEqual(["edited second", "first"]);
        yield* Effect.promise(() => vi.runAllTimersAsync());
        const completed = environment.getThread(DEMO_THREAD_ID);
        expect(
          completed.items
            .filter((item) => item.type === "user_message")
            .slice(-3)
            .map((item) => item.text),
        ).toEqual(["active", "edited second", "first"]);
        expect(
          completed.items
            .filter((item) => item.type === "assistant_message")
            .slice(-3)
            .map((item) => item.text),
        ).toEqual(scenarios.slice(0, 3).map((scenario) => scenario.answer));
        expect(completed.runs.find((run) => run.userMessageId === "cancelled")?.status).toBe(
          "cancelled",
        );
        expect(deriveThreadQueueWorkflowState(projectionOf(completed)).queuedRuns).toEqual([]);
        expect(isProjection(projectionOf(completed))).toBe(true);
        expect(
          environment.snapshot().threads.find((thread) => thread.id === DEMO_THREAD_ID)?.status,
        ).toBe("completed");
      } finally {
        environment.dispose();
        vi.useRealTimers();
      }
    }),
);

it.effect(
  "steers to the next scenario without dropping queued messages or accepting stale targets",
  () =>
    Effect.gen(function* () {
      vi.useFakeTimers();
      const environment = createDemoEnvironment();
      const dispatch = (input: Record<string, unknown>) =>
        environment.dispatch({
          commandId: CommandId.make("steering"),
          threadId: DEMO_THREAD_ID,
          ...input,
        });
      const send = (id: string, mode: unknown) =>
        dispatch({
          type: "message.dispatch",
          messageId: MessageId.make(id),
          text: id,
          attachments: [],
          createdBy: "user",
          creationSource: "web",
          dispatchMode: mode,
        });
      try {
        yield* send("original", { type: "start_immediately" });
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(250));
        const original = environment.getThread(DEMO_THREAD_ID).runs.at(-1)!;
        yield* send("queued after steer", { type: "queue_after_active" });
        yield* send("steering", { type: "steer_active", targetRunId: original.id });
        const steered = environment.getThread(DEMO_THREAD_ID);
        expect(steered.items.at(-1)).toMatchObject({ type: "user_message", inputIntent: "steer" });
        expect(steered.runs.find((run) => run.id === original.id)?.status).toBe("interrupted");
        expect(deriveThreadQueueWorkflowState(projectionOf(steered)).queuedRuns).toHaveLength(1);
        const stale = yield* Effect.exit(
          send("stale", { type: "steer_active", targetRunId: original.id }),
        );
        expect(Exit.isFailure(stale)).toBe(true);
        yield* Effect.promise(() => vi.runAllTimersAsync());
        const completed = environment.getThread(DEMO_THREAD_ID);
        expect(
          completed.items.some((item) => item.runId === original.id && item.type === "file_change"),
        ).toBe(false);
        expect(
          completed.items
            .filter((item) => item.type === "assistant_message")
            .slice(-2)
            .map((item) => item.text),
        ).toEqual(scenarios.slice(1, 3).map((scenario) => scenario.answer));
        yield* send("next after idle", { type: "start_immediately" });
        yield* Effect.promise(() => vi.runAllTimersAsync());
        expect(environment.getThread(DEMO_THREAD_ID).runs.at(-1)?.status).toBe("completed");
      } finally {
        environment.dispose();
        vi.useRealTimers();
      }
    }),
);

it.effect("promotes queued work, holds it on stop, and supports send-now and resume", () =>
  Effect.gen(function* () {
    vi.useFakeTimers();
    const environment = createDemoEnvironment();
    const dispatch = (input: Record<string, unknown>) =>
      environment.dispatch({
        commandId: CommandId.make("queue-resume"),
        threadId: DEMO_THREAD_ID,
        ...input,
      });
    const send = (id: string, queued = true) =>
      dispatch({
        type: "message.dispatch",
        messageId: MessageId.make(id),
        text: id,
        attachments: [],
        createdBy: "user",
        creationSource: "web",
        dispatchMode: { type: queued ? "queue_after_active" : "start_immediately" },
      });
    try {
      yield* send("active", false);
      const active = environment.getThread(DEMO_THREAD_ID).runs.at(-1)!;
      yield* send("first");
      yield* send("promote");
      yield* send("last");
      const queue = deriveThreadQueueWorkflowState(
        projectionOf(environment.getThread(DEMO_THREAD_ID)),
      ).queuedRuns;
      yield* dispatch({
        type: "queued-message.promote-to-steer",
        queuedRunId: queue[1]!.run.id,
        targetRunId: active.id,
      });
      expect(environment.getThread(DEMO_THREAD_ID).runs.at(-1)?.userMessageId).toBe("promote");
      expect(environment.getThread(DEMO_THREAD_ID).items.at(-1)).toMatchObject({
        type: "user_message",
        inputIntent: "promoted_queued_to_steer",
      });
      yield* dispatch({ type: "thread.stop" });
      yield* Effect.promise(() => vi.runAllTimersAsync());
      const held = deriveThreadQueueWorkflowState(
        projectionOf(environment.getThread(DEMO_THREAD_ID)),
      );
      expect(held.isHeld).toBe(true);
      expect(held.activeRun).toBeNull();
      expect(held.queuedRuns).toHaveLength(2);
      yield* dispatch({ type: "queued-run.start", runId: queue[0]!.run.id });
      yield* Effect.promise(() => vi.runAllTimersAsync());
      const afterSend = deriveThreadQueueWorkflowState(
        projectionOf(environment.getThread(DEMO_THREAD_ID)),
      );
      expect(afterSend.activeRun).toBeNull();
      expect(afterSend.isHeld).toBe(true);
      expect(afterSend.queuedRuns).toHaveLength(1);
      yield* dispatch({ type: "queue.resume" });
      yield* Effect.promise(() => vi.runAllTimersAsync());
      const waiting = environment.getThread(DEMO_THREAD_ID);
      expect(waiting.runs.at(-1)?.userMessageId).toBe("last");
      expect(waiting.runs.at(-1)?.status).toBe("completed");
      expect(isProjection(projectionOf(waiting))).toBe(true);
      expect(
        deriveThreadQueueWorkflowState(projectionOf(environment.getThread(DEMO_THREAD_ID)))
          .queuedRuns,
      ).toEqual([]);
    } finally {
      environment.dispose();
      vi.useRealTimers();
    }
  }),
);

it.effect("keeps local RPC replies compatible with the wire contracts", () =>
  Effect.gen(function* () {
    const environment = createDemoEnvironment();
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      [WS_METHODS.serverGetConfig, {}],
      [WS_METHODS.serverRefreshProviders, {}],
      [WS_METHODS.subscribeServerConfig, {}],
      [WS_METHODS.subscribeServerLifecycle, {}],
      [WS_METHODS.subscribeAuthAccess, {}],
      [WS_METHODS.subscribeVcsStatus, { cwd: "/workspace/orbit" }],
      [WS_METHODS.vcsRefreshStatus, { cwd: "/workspace/orbit" }],
      [WS_METHODS.vcsListRefs, { cwd: "/workspace/orbit" }],
      [WS_METHODS.subscribeTerminalMetadata, {}],
      [WS_METHODS.scheduledTasksSubscribe, {}],
      [WS_METHODS.projectsListEntries, { cwd: "/workspace/orbit" }],
      [WS_METHODS.projectsReadFile, { cwd: "/workspace/orbit", relativePath: "README.md" }],
      [WS_METHODS.projectsSearchEntries, { cwd: "/workspace/orbit", query: "src", limit: 20 }],
      [WS_METHODS.projectsListIgnoredFiles, { cwd: "/workspace/orbit" }],
      [WS_METHODS.filesystemBrowse, { partialPath: "/workspace" }],
      [WS_METHODS.filesystemGetMetadata, { paths: ["/workspace/orbit/README.md"] }],
      [ORCHESTRATION_V2_WS_METHODS.subscribeShell, {}],
      [ORCHESTRATION_V2_WS_METHODS.subscribeThread, { threadId: DEMO_THREAD_ID }],
      [ORCHESTRATION_V2_WS_METHODS.getThreadProjection, { threadId: DEMO_THREAD_ID }],
      [ORCHESTRATION_V2_WS_METHODS.getThreadFamily, { threadId: DEMO_THREAD_ID }],
      [ORCHESTRATION_V2_WS_METHODS.getArchivedShellSnapshot, {}],
      [
        ORCHESTRATION_V2_WS_METHODS.getOlderSettledThreads,
        { before: { settledAt: "2026-10-28T09:00:00Z" }, limit: 10 },
      ],
      [ORCHESTRATION_V2_WS_METHODS.getWorktreeThreadIds, { worktreePath: "/workspace/orbit" }],
      [
        ORCHESTRATION_V2_WS_METHODS.getTurnItem,
        { threadId: DEMO_THREAD_ID, itemId: "demo-feature-user" },
      ],
      [
        ORCHESTRATION_V2_WS_METHODS.getTurnDiff,
        { threadId: DEMO_THREAD_ID, fromTurnCount: 0, toTurnCount: 1 },
      ],
      [ORCHESTRATION_V2_WS_METHODS.getFullThreadDiff, { threadId: DEMO_THREAD_ID, toTurnCount: 1 }],
      [ORCHESTRATION_V2_WS_METHODS.searchThreads, { query: "command" }],
      [ORCHESTRATION_V2_WS_METHODS.searchThread, { threadId: DEMO_THREAD_ID, query: "command" }],
      [
        ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput,
        { threadId: DEMO_THREAD_ID, itemId: "demo-command" },
      ],
    ];
    const client = environment.session.client as unknown as Record<
      string,
      (input: unknown) => unknown
    >;
    try {
      for (const [method, input] of cases) {
        const rpc = WsRpcGroup.requests.get(method)!;
        const returned = client[method]!(input);
        if (RpcSchema.isStreamSchema(rpc.successSchema)) {
          const chunk = yield* Stream.runHead(returned as Stream.Stream<unknown, Error>);
          expect(chunk._tag, method).toBe("Some");
          if (chunk._tag === "Some")
            expect(validators.get(method)!(chunk.value), method).toBe(true);
        } else {
          const result = yield* returned as Effect.Effect<unknown, Error>;
          expect(validators.get(method)!(result), method).toBe(true);
        }
      }
    } finally {
      environment.dispose();
    }
  }),
);
