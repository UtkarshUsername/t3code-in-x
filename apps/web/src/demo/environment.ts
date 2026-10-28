import {
  AuthStandardClientScopes,
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  MessageId,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_V2_WS_METHODS as O,
  OrchestrationV2Command,
  OrchestrationV2DispatchCommandError,
  OrchestrationV2ThreadLaunchInput,
  OrchestrationV2ThreadLaunchError,
  CommandId,
  ProjectId,
  RunId,
  ServerConfig,
  ThreadId,
  WS_METHODS as W,
  WsRpcGroup,
  type OrchestrationV2ShellStreamItem,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2ShellSnapshot,
} from "@t3tools/contracts";
import type {
  ConnectionCatalogEntry,
  EnvironmentConnectionLease,
} from "@t3tools/client-runtime/connection";
import type { WsRpcProtocolClient } from "@t3tools/client-runtime/rpc";
import { ConnectionDriver } from "@t3tools/client-runtime/connection";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { RpcSchema } from "effect/rpc";
import { APP_VERSION } from "../branding";
import {
  REPLAY,
  DEMO_THREAD_ID,
  projects,
  files,
  createFixtures,
  shellOf,
  projectionOf,
  userItem,
  assistantItem,
  replayActivityItems,
  run,
  type DemoThread,
} from "./fixtures";
import { scenarioFor, scenarios } from "./scenarios";

export { DEMO_THREAD_ID };
export const DEMO_ENVIRONMENT_ID = EnvironmentId.make("demo-environment");
const descriptor = Schema.decodeSync(ExecutionEnvironmentDescriptor)({
  environmentId: DEMO_ENVIRONMENT_ID,
  label: "Interactive demo",
  platform: { os: "linux", arch: "x64" },
  serverVersion: APP_VERSION,
  orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
  capabilities: { repositoryIdentity: true, threadStop: true },
});
const auth = {
  policy: "loopback-browser",
  bootstrapMethods: ["one-time-token"],
  sessionMethods: ["browser-session-cookie"],
  sessionCookieName: "demo_session",
} as const;
export const demoConfig: ServerConfig = {
  ...Schema.decodeSync(ServerConfig)({
    environment: descriptor,
    auth,
    cwd: "/workspace/orbit",
    keybindingsConfigPath: "/workspace/.t3/keybindings.json",
    keybindings: [],
    issues: [],
    providers: [
      {
        instanceId: REPLAY,
        displayName: "Replay",
        driver: "codex",
        enabled: true,
        installed: true,
        version: "demo",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-10-28T09:00:00.000Z",
        models: scenarios.map((scenario) => ({
          slug: scenario.id,
          name: scenario.name,
          isCustom: false,
          capabilities: null,
        })),
      },
    ],
    availableEditors: [],
    observability: {
      logsDirectoryPath: "/workspace/.t3/logs",
      localTracingEnabled: false,
      otlpTracesEnabled: false,
      otlpMetricsEnabled: false,
    },
    settings: {
      providerInstances: {
        [REPLAY]: { driver: "codex", displayName: "Replay", enabled: true },
      },
    },
    threadSnapshotPagination: true,
    threadResumeCompletionMarker: true,
    shellResumeCompletionMarker: true,
  }),
  keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
};
class DemoUnsupportedOperation extends Schema.TaggedError<DemoUnsupportedOperation>()(
  "DemoUnsupportedOperation",
  { method: Schema.String, message: Schema.String },
) {}
const unavailable = (method: string) =>
  new DemoUnsupportedOperation({
    method,
    message:
      "This action needs a real T3 environment. This demo only runs scripted scenarios in your browser.",
  });
const now = () => DateTime.nowUnsafe();
const decodeCommand = Schema.decodeUnknownEffect(OrchestrationV2Command);
const decodeLaunch = Schema.decodeUnknownEffect(OrchestrationV2ThreadLaunchInput);
const encodeDescriptor = Schema.encodeSync(ExecutionEnvironmentDescriptor);

function channel<A>() {
  const subscribers = new Set<Queue.Queue<A>>();
  return {
    stream: (initial: () => ReadonlyArray<A>) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<A>();
          subscribers.add(queue);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              subscribers.delete(queue);
            }),
          );
          yield* Queue.offerAll(queue, initial());
          return Stream.fromQueue(queue);
        }),
      ),
    publish: (value: A) => {
      for (const queue of subscribers) Queue.offerUnsafe(queue, value);
    },
  };
}

export function createDemoEnvironment() {
  const threads = new Map(createFixtures().map((thread) => [thread.id, thread]));
  const shell = channel<OrchestrationV2ShellStreamItem>();
  const details = new Map<ThreadId, ReturnType<typeof channel<OrchestrationV2ThreadStreamItem>>>();
  const playback = new Map<ThreadId, ReturnType<typeof setTimeout>>();
  let sequence = 1;
  let nextId = 1;
  const getThread = (id: ThreadId) => {
    const thread = threads.get(id);
    if (!thread) throw new Error("This demo thread does not exist.");
    return thread;
  };
  const snapshot = (): OrchestrationV2ShellSnapshot => ({
    schemaVersion: 1,
    snapshotSequence: sequence,
    projects,
    threads: [...threads.values()]
      .filter((thread) => !thread.metadata?.deletedAt && !thread.metadata?.archivedAt)
      .map(shellOf),
    archivedThreads: [...threads.values()]
      .filter((thread) => !thread.metadata?.deletedAt && thread.metadata?.archivedAt)
      .map(shellOf),
  });
  const publish = (id: ThreadId) => {
    sequence += 1;
    shell.publish({ kind: "snapshot", snapshot: snapshot() });
    const thread = threads.get(id);
    if (thread)
      details.get(id)?.publish({
        kind: "snapshot",
        snapshotSequence: sequence,
        projection: projectionOf(thread),
      });
    return { sequence };
  };
  const replace = (thread: DemoThread) => {
    threads.set(thread.id, thread);
    return publish(thread.id);
  };
  const stop = (id: ThreadId) => {
    clearTimeout(playback.get(id));
    playback.delete(id);
    const thread = getThread(id);
    return replace({
      ...thread,
      runs: thread.runs.map((value) =>
        value.status === "running"
          ? { ...value, status: "interrupted", completedAt: now() }
          : value,
      ),
      items: thread.items.map((item) =>
        item.status === "running"
          ? {
              ...item,
              status: "interrupted",
              completedAt: now(),
              ...("streaming" in item ? { streaming: false } : {}),
            }
          : item,
      ),
    });
  };
  const start = (
    id: ThreadId,
    text: string,
    messageId: MessageId,
    model = getThread(id).modelSelection,
  ) => {
    const thread = getThread(id);
    if (thread.runs.some((value) => value.status === "running"))
      throw new Error("Stop the active replay before starting another turn.");
    const runId = RunId.make(`demo-run-${nextId++}`);
    const scenario = scenarioFor(model.model);
    const startedAt = now();
    const user = {
      ...userItem(id, runId, messageId, thread.items.length, text),
      startedAt,
      updatedAt: startedAt,
      completedAt: startedAt,
    };
    const activity = replayActivityItems(id, runId, thread.items.length + 1, scenario, startedAt);
    const agent = {
      ...assistantItem(
        id,
        runId,
        `${runId}-assistant`,
        thread.items.length + activity.length + 1,
        "",
        true,
      ),
      startedAt,
      updatedAt: startedAt,
    };
    const replayRun = {
      ...run(id, runId, thread.runs.length + 1, messageId),
      modelSelection: model,
      requestedAt: startedAt,
      startedAt,
      completedAt: null,
      status: "running" as const,
    };
    replace({
      ...thread,
      modelSelection: model,
      settled: false,
      metadata: { ...thread.metadata, updatedAt: startedAt, latestUserMessageAt: startedAt },
      runs: [...thread.runs, replayRun],
      items: [...thread.items, user, ...activity, agent],
    });
    const words = (scenario.introduction + "\n\n" + scenario.answer).match(/\S+\s*/g) ?? [];
    let position = 0;
    let textSoFar = "";
    const advance = () => {
      if (!playback.has(id)) return;
      position += 5;
      textSoFar = words.slice(0, position).join("");
      const done = position >= words.length;
      const current = getThread(id);
      const items = current.items.map((item) =>
        item.id === agent.id
          ? {
              ...agent,
              text: textSoFar,
              streaming: !done,
              status: done ? ("completed" as const) : ("running" as const),
              completedAt: done ? now() : null,
            }
          : item,
      );
      replace({
        ...current,
        items,
        runs: current.runs.map((value) =>
          value.id === runId && done
            ? { ...value, status: "completed", completedAt: now() }
            : value,
        ),
      });
      if (done) playback.delete(id);
      else playback.set(id, setTimeout(advance, 110));
    };
    playback.set(id, setTimeout(advance, 250));
    return { sequence };
  };
  const dispatch = Effect.fn("Demo.dispatch")(function* (input: unknown) {
    const failure = (cause: unknown) =>
      new OrchestrationV2DispatchCommandError({
        commandId: CommandId.make(
          typeof input === "object" && input !== null && "commandId" in input
            ? String(input.commandId)
            : "invalid-demo-command",
        ),
        commandType:
          typeof input === "object" && input !== null && "type" in input
            ? String(input.type)
            : "invalid",
        message: cause instanceof Error ? cause.message : "This demo action is unavailable.",
      });
    const command = yield* decodeCommand(input).pipe(Effect.mapError(failure));
    return yield* Effect.try({
      try: () => {
        if (!("threadId" in command)) throw unavailable(command.type);
        const thread = getThread(command.threadId);
        const metadata = { ...thread.metadata, updatedAt: now() };
        switch (command.type) {
          case "message.dispatch":
            return start(
              command.threadId,
              command.text,
              command.messageId,
              command.modelSelection ?? thread.modelSelection,
            );
          case "thread.stop":
          case "run.interrupt":
            return stop(command.threadId);
          case "thread.metadata.update":
            return replace({
              ...thread,
              title: command.title ?? thread.title,
              metadata: {
                ...metadata,
                ...(command.branch !== undefined ? { branch: command.branch } : {}),
              },
            });
          case "thread.settle":
            return replace({ ...thread, settled: true, metadata });
          case "thread.unsettle":
            return replace({ ...thread, settled: false, metadata });
          case "thread.archive":
            return replace({ ...thread, metadata: { ...metadata, archivedAt: now() } });
          case "thread.unarchive":
            return replace({ ...thread, metadata: { ...metadata, archivedAt: null } });
          case "thread.delete":
            stop(command.threadId);
            return replace({
              ...getThread(command.threadId),
              metadata: { ...metadata, deletedAt: now() },
            });
          case "thread.visit":
            return replace({
              ...thread,
              metadata: {
                ...thread.metadata,
                lastVisitedAt: DateTime.makeUnsafe(command.visitedAt),
              },
            });
          case "thread.model-selection.set":
            return replace({ ...thread, modelSelection: command.modelSelection, metadata });
          case "thread.runtime-mode.set":
            return replace({
              ...thread,
              metadata: { ...metadata, runtimeMode: command.runtimeMode },
            });
          case "thread.interaction-mode.set":
            return replace({
              ...thread,
              metadata: { ...metadata, interactionMode: command.interactionMode },
            });
          case "thread.pin":
            return replace({
              ...thread,
              settled: false,
              metadata: { ...metadata, pinnedAt: now(), pinOrderKey: command.orderKey ?? null },
            });
          case "thread.unpin":
            return replace({
              ...thread,
              metadata: { ...metadata, pinnedAt: null, pinOrderKey: null },
            });
          case "thread.pin.reorder":
            return replace({ ...thread, metadata: { ...metadata, pinOrderKey: command.orderKey } });
          case "thread.active.reorder":
            return replace({
              ...thread,
              metadata: { ...metadata, activeOrderKey: command.orderKey },
            });
          case "thread.snooze":
            return replace({
              ...thread,
              metadata: {
                ...metadata,
                snoozedAt: now(),
                snoozedUntil: DateTime.makeUnsafe(command.snoozedUntil),
              },
            });
          case "thread.unsnooze":
            return replace({
              ...thread,
              metadata: { ...metadata, snoozedAt: null, snoozedUntil: null },
            });
          case "thread.auto-settle.set":
            return replace({
              ...thread,
              metadata: { ...metadata, autoSettleDisabledAt: command.enabled ? null : now() },
            });
          default:
            throw unavailable(command.type);
        }
      },
      catch: failure,
    });
  });
  const launch = Effect.fn("Demo.launch")(function* (input: unknown) {
    const failure = (cause: unknown) =>
      new OrchestrationV2ThreadLaunchError({
        commandId: CommandId.make(
          typeof input === "object" && input !== null && "commandId" in input
            ? String(input.commandId)
            : "invalid-demo-launch",
        ),
        projectId: ProjectId.make(
          typeof input === "object" && input !== null && "projectId" in input
            ? String(input.projectId)
            : "invalid-demo-project",
        ),
        message: cause instanceof Error ? cause.message : "This demo action is unavailable.",
      });
    const value = yield* decodeLaunch(input).pipe(Effect.mapError(failure));
    return yield* Effect.try({
      try: () => {
        const id = value.threadId ?? ThreadId.make(`demo-thread-${nextId++}`);
        if (!projects.some((project) => project.id === value.projectId))
          throw new Error("Unknown demo project.");
        if (!value.reuseExistingThread)
          threads.set(id, {
            id,
            projectId: value.projectId,
            title: value.title,
            modelSelection: value.modelSelection,
            settled: false,
            runs: [],
            items: [],
            metadata: { runtimeMode: value.runtimeMode, interactionMode: value.interactionMode },
          });
        if (value.initialMessage)
          start(
            id,
            value.initialMessage.text,
            value.initialMessage.messageId ?? MessageId.make(`demo-message-${nextId++}`),
            value.modelSelection,
          );
        else publish(id);
        return { threadId: id, projection: projectionOf(getThread(id)), resumed: false };
      },
      catch: failure,
    });
  });
  const steady = <A>(value: A) => Stream.concat(Stream.make(value), Stream.never);
  const localVcs = {
    isRepo: true,
    hasPrimaryRemote: false,
    isDefaultRef: true,
    refName: "main",
    hasWorkingTreeChanges: false,
    workingTree: { rootPath: "/workspace/orbit", files: [], insertions: 0, deletions: 0 },
  };
  const remoteVcs = { hasUpstream: false, aheadCount: 0, behindCount: 0, pr: null };
  const handlers: Record<string, (input: unknown) => unknown> = {
    [O.subscribeShell]: () =>
      shell.stream(() => [{ kind: "snapshot", snapshot: snapshot() }, { kind: "synchronized" }]),
    [O.subscribeThread]: (input) => {
      const { threadId } = input as { threadId: ThreadId };
      let detail = details.get(threadId);
      if (!detail) {
        detail = channel();
        details.set(threadId, detail);
      }
      return detail.stream(() => [
        {
          kind: "snapshot",
          snapshotSequence: sequence,
          projection: projectionOf(getThread(threadId)),
        },
        { kind: "synchronized" },
      ]);
    },
    [O.getThreadProjection]: (input) =>
      Effect.sync(() => projectionOf(getThread((input as { threadId: ThreadId }).threadId))),
    [O.dispatchCommand]: dispatch,
    [O.launchThread]: launch,
    [O.getArchivedShellSnapshot]: () =>
      Effect.sync(() => ({
        schemaVersion: 1,
        snapshotSequence: sequence,
        projects,
        threads: snapshot().archivedThreads,
      })),
    [O.searchThreads]: (input) =>
      Effect.sync(() => {
        const query = (input as { query: string }).query.toLowerCase();
        return {
          snapshotSequence: sequence,
          threads: snapshot().threads.filter((thread) =>
            thread.title.toLowerCase().includes(query),
          ),
          matches: [...threads.values()].flatMap((thread) =>
            thread.items.flatMap((item) =>
              (item.type === "user_message" || item.type === "assistant_message") &&
              item.text.toLowerCase().includes(query)
                ? [
                    {
                      threadId: thread.id,
                      projectId: thread.projectId,
                      source: item.type === "user_message" ? "user" : "assistant",
                      snippet: item.text.slice(0, 240),
                      messageCreatedAt: null,
                      messageId: item.messageId,
                    },
                  ]
                : [],
            ),
          ),
        };
      }),
    [O.searchThread]: (input) =>
      Effect.sync(() => {
        const value = input as { threadId: ThreadId; query: string };
        const match = getThread(value.threadId).items.find(
          (item) =>
            (item.type === "user_message" || item.type === "assistant_message") &&
            item.text.toLowerCase().includes(value.query.toLowerCase()),
        );
        return {
          snapshotSequence: sequence,
          complete: true,
          totalMatches: match ? 1 : 0,
          activeIndex: 0,
          match: match ? { entryId: match.id, runId: match.runId, occurrence: 0 } : null,
        };
      }),
    [O.getThreadFamily]: (input) =>
      Effect.sync(() => ({
        snapshotSequence: sequence,
        threads: [shellOf(getThread((input as { threadId: ThreadId }).threadId))],
      })),
    [O.getOlderSettledThreads]: () =>
      Effect.succeed({ snapshotSequence: sequence, threads: [], counts: [] }),
    [O.getWorktreeThreadIds]: () => Effect.succeed({ threadIds: [] }),
    [O.getTurnItem]: (input) =>
      Effect.sync(() => {
        const value = input as { threadId: ThreadId; itemId: string };
        return {
          item: getThread(value.threadId).items.find((item) => item.id === value.itemId) ?? null,
        };
      }),
    [O.getTurnDiff]: (input) =>
      Effect.sync(() => {
        const value = input as { threadId: ThreadId; fromTurnCount: number; toTurnCount: number };
        return { ...value, diff: scenarioFor(getThread(value.threadId).modelSelection.model).diff };
      }),
    [O.getFullThreadDiff]: (input) =>
      Effect.sync(() => {
        const value = input as { threadId: ThreadId; toTurnCount: number };
        return {
          ...value,
          fromTurnCount: 0,
          diff: scenarioFor(getThread(value.threadId).modelSelection.model).diff,
        };
      }),
    [O.subscribeCommandOutput]: () =>
      steady({
        kind: "replace",
        text: "✓ Focused checks passed (simulated)\n",
        truncated: false,
        running: false,
      }),
    [W.serverGetConfig]: () => Effect.succeed(demoConfig),
    [W.serverRefreshProviders]: () => Effect.succeed({ providers: demoConfig.providers }),
    [W.subscribeServerConfig]: () => steady({ version: 1, type: "snapshot", config: demoConfig }),
    [W.subscribeServerLifecycle]: () =>
      steady({
        version: 1,
        sequence: 1,
        type: "welcome",
        payload: {
          environment: descriptor,
          cwd: "/workspace/orbit",
          projectName: "orbit",
          bootstrapStatus: "complete",
          bootstrapProjectId: projects[0]!.id,
          bootstrapThreadId: DEMO_THREAD_ID,
          bootstrapProjectCreated: false,
          bootstrapThreadCreated: false,
        },
      }),
    [W.subscribeAuthAccess]: () =>
      steady({
        version: 1,
        revision: 1,
        type: "snapshot",
        payload: { pairingLinks: [], clientSessions: [] },
      }),
    [W.subscribeVcsStatus]: () => steady({ _tag: "snapshot", local: localVcs, remote: remoteVcs }),
    [W.vcsRefreshStatus]: () => Effect.succeed({ ...localVcs, ...remoteVcs }),
    [W.vcsListRefs]: () =>
      Effect.succeed({
        isRepo: true,
        hasPrimaryRemote: false,
        isAtRepositoryRoot: true,
        refs: [{ name: "main", current: true, isDefault: true, worktreePath: null }],
        nextCursor: null,
        totalCount: 1,
      }),
    [W.subscribeTerminalMetadata]: () => steady({ type: "snapshot", terminals: [] }),
    [W.subscribeWorktreeSetup]: () => Stream.never,
    [W.subscribeProjectClones]: () => Stream.never,
    [W.subscribePreviewEvents]: () => Stream.never,
    [W.subscribeDiscoveredLocalServers]: () => Stream.never,
    [W.subscribeResourceTelemetry]: () => Stream.never,
    [W.projectsListEntries]: (input) =>
      Effect.sync(() => {
        const directory = (input as { directoryPath?: string }).directoryPath ?? "";
        const entries = new Map<string, "file" | "directory">();
        for (const path of Object.keys(files)) {
          const prefix = directory ? directory.replace(/\/$/, "") + "/" : "";
          if (!path.startsWith(prefix)) continue;
          const rest = path.slice(prefix.length);
          const name = rest.split("/")[0]!;
          entries.set(prefix + name, rest.includes("/") ? "directory" : "file");
        }
        return { entries: [...entries].map(([path, kind]) => ({ path, kind })), truncated: false };
      }),
    [W.projectsSearchEntries]: (input) =>
      Effect.sync(() => ({
        entries: Object.keys(files)
          .filter((path) =>
            path.toLowerCase().includes((input as { query: string }).query.toLowerCase()),
          )
          .map((path) => ({ path, kind: "file" })),
        truncated: false,
      })),
    [W.projectsListIgnoredFiles]: () => Effect.succeed({ files: [], truncated: false }),
    [W.projectsReadFile]: (input) =>
      Effect.try({
        try: () => {
          const value = input as { relativePath: string; allowMissing?: boolean };
          const path = value.relativePath.replace(/^\/workspace\/[^/]+\//, "");
          const contents = files[path];
          if (contents === undefined && !value.allowMissing) throw unavailable(W.projectsReadFile);
          return {
            relativePath: value.relativePath,
            contents: contents ?? "",
            byteLength: new TextEncoder().encode(contents ?? "").length,
            truncated: false,
            exists: contents !== undefined,
          };
        },
        catch: () => unavailable(W.projectsReadFile),
      }),
    [W.filesystemGetMetadata]: (input) =>
      Effect.sync(() => ({
        entries: (input as { paths: string[] }).paths.map((path) =>
          path.includes(".") ? { kind: "file", byteLength: 128 } : { kind: "directory" },
        ),
      })),
    [W.filesystemBrowse]: () =>
      Effect.succeed({
        parentPath: "/workspace",
        entries: projects.map((project) => ({
          name: project.title,
          fullPath: project.workspaceRoot,
        })),
      }),
  };
  // RPC payloads and return types are correlated dynamically by method name at this boundary.
  const client = new Proxy(handlers, {
    get: (target, method: string) =>
      target[method] ??
      (() => {
        const rpc = WsRpcGroup.requests.get(method);
        return rpc && RpcSchema.isStreamSchema(rpc.successSchema)
          ? Stream.fail(unavailable(method))
          : Effect.fail(unavailable(method));
      }),
  }) as unknown as WsRpcProtocolClient;
  const session: EnvironmentConnectionLease["session"] = {
    client,
    initialConfig: Effect.succeed(demoConfig),
    subscribeServerConfig: () =>
      steady({ version: 1 as const, type: "snapshot" as const, config: demoConfig }),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
  return {
    session,
    snapshot,
    getThread,
    dispatch,
    launch,
    dispose: () => {
      for (const timer of playback.values()) clearTimeout(timer);
      playback.clear();
    },
  };
}

const environment = createDemoEnvironment();
export const demoDriverLayer = Layer.succeed(
  ConnectionDriver,
  ConnectionDriver.of({
    connect: Effect.fn("Demo.connect")(function* (entry: ConnectionCatalogEntry) {
      return yield* Effect.succeed({
        prepared: {
          environmentId: DEMO_ENVIRONMENT_ID,
          label: descriptor.label,
          httpBaseUrl: window.location.origin,
          socketUrl: window.location.origin.replace(/^http/, "ws"),
          httpAuthorization: null,
          target: entry.target,
        },
        session: environment.session,
      });
    }),
    preflight: Effect.fn("Demo.preflight")(function* () {
      return yield* Effect.succeed(true);
    }),
    checkHost: Effect.fn("Demo.checkHost")(function* () {
      return yield* Effect.succeed("unchecked" as const);
    }),
  }),
);

export function installDemoHttp(): Disposable {
  const previous = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
    const json = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url.pathname === "/.well-known/t3/environment") return json(encodeDescriptor(descriptor));
    if (url.pathname === "/api/auth/session")
      return json({
        authenticated: true,
        auth,
        scopes: AuthStandardClientScopes,
        sessionMethod: "browser-session-cookie",
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
    if (/^\/(api|oauth|\.well-known)\//.test(url.pathname))
      return json({ message: "Not available in the static demo" }, 404);
    if (url.origin !== window.location.origin)
      return json({ message: "The static demo does not contact external services" }, 403);
    return previous(input, init);
  };
  return {
    [Symbol.dispose]: () => {
      environment.dispose();
      globalThis.fetch = previous;
    },
  };
}
