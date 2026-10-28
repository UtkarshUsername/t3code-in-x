import { expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import { RpcSchema } from "effect/rpc";
import * as Exit from "effect/Exit";
import {
  CommandId,
  WsRpcGroup,
  MessageId,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ShellSnapshot,
  ThreadId,
  WS_METHODS,
  ORCHESTRATION_V2_WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { createDemoEnvironment, DEMO_THREAD_ID } from "./environment";
import { MODEL, projects, projectionOf } from "./fixtures";

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
    const environment = createDemoEnvironment();
    try {
      const id = ThreadId.make("visitor-thread");
      const result = yield* environment.launch({
        commandId: CommandId.make("launch-1"),
        threadId: id,
        projectId: projects[1]!.id,
        title: "Find the bug",
        modelSelection: { ...MODEL, model: "bugfix" },
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
        environment.snapshot().threads.find((thread) => thread.id === id)?.activeRunId,
      ).toBeTruthy();
      yield* Effect.promise(() => vi.runAllTimersAsync());
      const completed = environment.getThread(id);
      expect(completed.runs.at(-1)?.status).toBe("completed");
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
      expect(running.items.at(-1)?.type).toBe("assistant_message");
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
          const chunk = yield* Stream.runHead(returned as Stream.Stream<unknown, unknown>);
          expect(chunk._tag, method).toBe("Some");
          if (chunk._tag === "Some")
            expect(validators.get(method)!(chunk.value), method).toBe(true);
        } else {
          const result = yield* returned as Effect.Effect<unknown, unknown>;
          expect(validators.get(method)!(result), method).toBe(true);
        }
      }
    } finally {
      environment.dispose();
    }
  }),
);
