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
import { threadSupportsProviderHandoff } from "@t3tools/client-runtime/state/thread-workflows";
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import { scenarios } from "./scenarios";

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
        },
      });
      yield* Effect.promise(() => vi.runAllTimersAsync());
      const followUp = environment.getThread(id);
      expect(followUp.runs.at(-1)?.providerInstanceId).toBe("opencode");
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
                  for (const approval of requests.approvals) {
                    expect(approval.responseCapability).toBe("live");
                    const latestRun = environment.getThread(DEMO_THREAD_ID).runs.at(-1)!;
                    expect(
                      waiting.turnItems
                        .filter((item) => item.runId === latestRun.id)
                        .some((item) => item.type === "file_change"),
                    ).toBe(false);
                    yield* dispatch({
                      type: "runtime-request.respond",
                      requestId: approval.requestId,
                      decision: "accept",
                    });
                  }
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

it.effect(
  "declines and cancels pending requests without applying an edit or resuming stale work",
  () =>
    Effect.gen(function* () {
      vi.useFakeTimers();
      const index = scenarios.findIndex((scenario) => scenario.id === "migration");
      const environment = createDemoEnvironment(index);
      const dispatch = (input: Record<string, unknown>) =>
        environment.dispatch({
          commandId: CommandId.make("approval-lifecycle"),
          threadId: DEMO_THREAD_ID,
          ...input,
        });
      const send = () =>
        dispatch({
          type: "message.dispatch",
          messageId: MessageId.make("approval-message"),
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
        yield* dispatch({
          type: "runtime-request.respond",
          requestId: first.id,
          decision: "decline",
        });
        yield* Effect.promise(() => vi.runAllTimersAsync());
        const declined = environment.getThread(DEMO_THREAD_ID);
        expect(
          declined.items
            .filter((item) => item.runId === declined.runs.at(-1)?.id)
            .some((item) => item.type === "file_change"),
        ).toBe(false);
        expect(declined.requests!.at(-1)?.decision).toBe("decline");
        yield* send();
        yield* Effect.promise(() => vi.runAllTimersAsync());
        const second = environment.getThread(DEMO_THREAD_ID).requests!.at(-1)!;
        yield* dispatch({ type: "thread.stop" });
        const stopped = environment.snapshot().snapshotSequence;
        const stale = yield* Effect.exit(
          dispatch({ type: "runtime-request.respond", requestId: second.id, decision: "accept" }),
        );
        expect(Exit.isFailure(stale)).toBe(true);
        yield* Effect.promise(() => vi.runAllTimersAsync());
        expect(environment.snapshot().snapshotSequence).toBe(stopped);
        expect(environment.getThread(DEMO_THREAD_ID).requests!.at(-1)?.status).toBe("cancelled");
        expect(environment.getThread(DEMO_THREAD_ID).runs.at(-1)?.status).toBe("interrupted");
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
