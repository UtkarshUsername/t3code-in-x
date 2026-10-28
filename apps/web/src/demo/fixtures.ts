import {
  MessageId,
  NodeId,
  PlanId,
  ProjectId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2Run,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { scenarioFor, type DemoStep, type DemoTurn } from "./scenarios";
import { DEFAULT_DEMO_MODEL, demoProviders } from "./providers";
import { demoCapabilities } from "./capabilities";

const providerThreadId = (id: ThreadId, instanceId: ModelSelection["instanceId"]) =>
  ProviderThreadId.make(`demo-provider-${id}-${instanceId}`);
export const demoSessionId = (id: ThreadId, instanceId: ModelSelection["instanceId"]) =>
  ProviderSessionId.make(`demo-session-${id}-${instanceId}`);

const MODEL = DEFAULT_DEMO_MODEL;
const AT = DateTime.makeUnsafe("2026-10-28T09:00:00.000Z");
export const DEMO_THREAD_ID = ThreadId.make("demo-feature");
export const projects: ReadonlyArray<OrchestrationProjectShell> = [
  {
    id: ProjectId.make("demo-orbit"),
    title: "orbit",
    workspaceRoot: "/workspace/orbit",
    repositoryIdentity: null,
    defaultModelSelection: MODEL,
    scripts: [],
    createdAt: "2026-10-28T09:00:00.000Z",
    updatedAt: "2026-10-28T09:00:00.000Z",
  },
  {
    id: ProjectId.make("demo-notes"),
    title: "field-notes",
    workspaceRoot: "/workspace/field-notes",
    repositoryIdentity: null,
    defaultModelSelection: MODEL,
    scripts: [],
    createdAt: "2026-10-28T09:00:00.000Z",
    updatedAt: "2026-10-28T09:00:00.000Z",
  },
];
const base = (threadId: ThreadId, runId: RunId, id: string, ordinal: number) => ({
  id: TurnItemId.make(id),
  threadId,
  runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal,
  status: "completed" as const,
  title: null,
  startedAt: AT,
  completedAt: AT,
  updatedAt: AT,
});

export function userItem(
  threadId: ThreadId,
  runId: RunId,
  id: string,
  ordinal: number,
  text: string,
) {
  return {
    ...base(threadId, runId, id, ordinal),
    type: "user_message",
    messageId: MessageId.make(id),
    text,
    attachments: [],
    inputIntent: "turn_start",
    createdBy: "user",
    creationSource: "web",
  } satisfies OrchestrationV2TurnItem;
}

export function assistantItem(
  threadId: ThreadId,
  runId: RunId,
  id: string,
  ordinal: number,
  text: string,
  streaming = false,
) {
  return {
    ...base(threadId, runId, id, ordinal),
    type: "assistant_message",
    messageId: MessageId.make(id),
    text,
    streaming,
    ...(streaming ? { status: "running" as const, completedAt: null } : {}),
  } satisfies OrchestrationV2TurnItem;
}

function replayActivityItems(
  threadId: ThreadId,
  runId: RunId,
  ordinal: number,
  scenario: DemoTurn,
  at = AT,
) {
  const items: OrchestrationV2TurnItem[] = [];
  for (const step of scenario.steps) {
    if (step.type === "question") break;
    const item = replayStepItem(threadId, runId, ordinal + items.length, step, at);
    const existing = items.findIndex((candidate) => candidate.id === item.id);
    if (existing === -1) items.push(item);
    else items[existing] = { ...item, ordinal: items[existing]!.ordinal };
  }
  return items;
}

export function replayStepItem(
  threadId: ThreadId,
  runId: RunId,
  ordinal: number,
  step: DemoStep,
  at: DateTime.Utc,
): OrchestrationV2TurnItem {
  const common = {
    ...base(threadId, runId, `${runId}-step-${ordinal}`, ordinal),
    startedAt: at,
    updatedAt: at,
    completedAt: at,
  };
  switch (step.type) {
    case "reasoning":
      return { ...common, type: "reasoning", text: step.text, streaming: false };
    case "plan":
      return {
        ...common,
        id: TurnItemId.make(`${runId}-plan`),
        type: "todo_list",
        planId: PlanId.make(`${runId}-plan`),
        steps: step.steps.map((text, index) => ({
          id: `step-${index}`,
          text,
          status:
            index < step.current ? "completed" : index === step.current ? "running" : "pending",
        })),
      };
    case "read":
      return {
        ...common,
        type: "dynamic_tool",
        toolName: "read_file",
        title: `Read ${step.path}`,
        input: { path: step.path },
        output: files[step.path] ?? "Demo file contents unavailable.",
      };
    case "edit":
      return { ...common, type: "file_change", fileName: step.file, diffStr: step.diff };
    case "command":
      return {
        ...common,
        type: "command_execution",
        title: step.input,
        input: step.input,
        output: step.output,
        exitCode: step.exitCode ?? 0,
        status: step.exitCode ? "failed" : "completed",
      };
    case "question":
      return {
        ...common,
        type: "user_input_request",
        requestId: RuntimeRequestId.make(common.id),
        questions: [...step.questions],
      };
  }
}

export function run(
  threadId: ThreadId,
  id: RunId,
  ordinal: number,
  userMessageId: string,
  modelSelection = MODEL,
) {
  return {
    id,
    threadId,
    ordinal,
    providerInstanceId: modelSelection.instanceId,
    modelSelection,
    providerThreadId: providerThreadId(threadId, modelSelection.instanceId),
    userMessageId: MessageId.make(userMessageId),
    rootNodeId: NodeId.make(`${id}-node`),
    activeAttemptId: RunAttemptId.make(`${id}-attempt`),
    status: "completed",
    requestedAt: AT,
    startedAt: AT,
    completedAt: AT,
    checkpointId: null,
    contextHandoffId: null,
  } satisfies OrchestrationV2Run;
}

export interface DemoThread {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly settled: boolean;
  readonly metadata?: Partial<OrchestrationV2ThreadShell>;
  readonly runs: ReadonlyArray<OrchestrationV2Run>;
  readonly items: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly requests?: ReadonlyArray<OrchestrationV2RuntimeRequest>;
  readonly continuation?: DemoTurn | undefined;
  readonly queuedMessages?: ReadonlyArray<OrchestrationV2ConversationMessage>;
}

export function shellOf(thread: DemoThread): OrchestrationV2ThreadShell {
  const active = thread.runs.findLast((run) => ["running", "waiting"].includes(run.status));
  const latest =
    active ?? thread.runs.findLast((run) => run.status !== "queued") ?? thread.runs.at(-1);
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    providerInstanceId: thread.modelSelection.instanceId,
    modelSelection: thread.modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    activeProviderThreadId: providerThreadId(thread.id, thread.modelSelection.instanceId),
    lineage: { rootThreadId: thread.id, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: latest?.id ?? null,
    activeRunId: active?.id ?? null,
    activityRunStatus: active?.status === "waiting" ? "waiting" : active ? "running" : null,
    activityRunStartedAt: active?.startedAt ?? null,
    status: latest?.status ?? "idle",
    pendingRuntimeRequest: (() => {
      const request = thread.requests?.find((request) => request.status === "pending");
      return request ? { id: request.id, kind: request.kind, createdAt: request.createdAt } : null;
    })(),
    latestVisibleMessage: null,
    latestUserMessageAt: AT,
    hasActionableProposedPlan: false,
    itemCount: thread.items.length,
    visibleItemCount: thread.items.length,
    createdAt: AT,
    updatedAt: AT,
    archivedAt: null,
    settledOverride: thread.settled ? "settled" : "active",
    settledAt: thread.settled ? AT : null,
    lastVisitedAt: AT,
    deletedAt: null,
    ...thread.metadata,
  };
}

export function projectionOf(thread: DemoThread): OrchestrationV2ThreadProjection {
  const shell = shellOf(thread);
  const instanceIds = [
    ...new Set([
      thread.modelSelection.instanceId,
      ...thread.runs.map((run) => run.providerInstanceId),
    ]),
  ];
  const driverFor = (instanceId: ModelSelection["instanceId"]) =>
    demoProviders.find((provider) => provider.instanceId === instanceId)!.driver;
  const executions = thread.runs.filter((run) => run.startedAt !== null);
  const executionStatus = (run: OrchestrationV2Run) => {
    switch (run.status) {
      case "completed":
      case "interrupted":
      case "failed":
      case "cancelled":
        return run.status;
      default:
        return "running" as const;
    }
  };
  const visibleTurnItems: OrchestrationV2ProjectedTurnItem[] = thread.items.map(
    (item, position) => ({
      position,
      visibility: "local",
      sourceThreadId: thread.id,
      sourceItemId: item.id,
      item,
    }),
  );
  return {
    thread: {
      id: shell.id,
      projectId: shell.projectId,
      title: shell.title,
      providerInstanceId: shell.providerInstanceId,
      modelSelection: shell.modelSelection,
      runtimeMode: shell.runtimeMode,
      interactionMode: shell.interactionMode,
      branch: shell.branch,
      worktreePath: shell.worktreePath,
      activeProviderThreadId: shell.activeProviderThreadId,
      lineage: shell.lineage,
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: shell.createdAt,
      updatedAt: shell.updatedAt,
      archivedAt: shell.archivedAt,
      settledOverride: shell.settledOverride,
      settledAt: shell.settledAt,
      lastVisitedAt: shell.lastVisitedAt ?? null,
      deletedAt: shell.deletedAt,
    },
    runs: [...thread.runs],
    attempts: executions.map((run) => ({
      id: run.activeAttemptId!,
      runId: run.id,
      attemptOrdinal: 1,
      rootNodeId: run.rootNodeId!,
      providerInstanceId: run.providerInstanceId,
      providerThreadId: run.providerThreadId!,
      providerTurnId: ProviderTurnId.make(`${run.id}-turn`),
      reason: "initial",
      status: executionStatus(run),
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    })),
    nodes: executions.map((run) => ({
      id: run.rootNodeId!,
      threadId: thread.id,
      runId: run.id,
      parentNodeId: null,
      rootNodeId: run.rootNodeId!,
      kind: "root_turn",
      status: run.status === "waiting" ? "waiting" : executionStatus(run),
      countsForRun: true,
      providerThreadId: run.providerThreadId,
      providerTurnId: ProviderTurnId.make(`${run.id}-turn`),
      nativeItemRef: null,
      runtimeRequestId:
        thread.requests?.find(
          (request) => request.nodeId === run.rootNodeId && request.status === "pending",
        )?.id ?? null,
      checkpointScopeId: null,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    })),
    subagents: [],
    providerSessions: instanceIds.map((instanceId) => ({
      id: demoSessionId(thread.id, instanceId),
      driver: driverFor(instanceId),
      providerInstanceId: instanceId,
      status:
        shell.activeRunId !== null && thread.modelSelection.instanceId === instanceId
          ? "running"
          : "ready",
      cwd: projects.find((project) => project.id === thread.projectId)!.workspaceRoot,
      model:
        instanceId === thread.modelSelection.instanceId
          ? thread.modelSelection.model
          : (executions.findLast((run) => run.providerInstanceId === instanceId)?.modelSelection
              .model ?? null),
      capabilities: demoCapabilities,
      createdAt: shell.createdAt,
      updatedAt: shell.updatedAt,
      lastError: null,
    })),
    providerThreads: instanceIds.map((instanceId) => ({
      id: providerThreadId(thread.id, instanceId),
      driver: driverFor(instanceId),
      providerInstanceId: instanceId,
      providerSessionId: demoSessionId(thread.id, instanceId),
      appThreadId: thread.id,
      ownerNodeId: null,
      nativeThreadRef: { driver: driverFor(instanceId), nativeId: thread.id, strength: "strong" },
      nativeConversationHeadRef: null,
      status:
        shell.activeRunId !== null && instanceId === thread.modelSelection.instanceId
          ? "active"
          : "idle",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      pendingBackgroundTasks: [],
      contextUsage: null,
      nativeMetadata: null,
      goal: null,
      createdAt: shell.createdAt,
      updatedAt: shell.updatedAt,
    })),
    providerTurns: executions.map((run) => ({
      id: ProviderTurnId.make(`${run.id}-turn`),
      providerThreadId: run.providerThreadId!,
      nodeId: run.rootNodeId!,
      runAttemptId: run.activeAttemptId,
      nativeTurnRef: null,
      ordinal: run.ordinal,
      status: executionStatus(run),
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    })),
    runtimeRequests: [...(thread.requests ?? [])],
    messages: [
      ...(thread.queuedMessages ?? []),
      ...thread.items.flatMap((item): OrchestrationV2ConversationMessage[] =>
        item.type === "user_message" || item.type === "assistant_message"
          ? [
              {
                id: item.messageId,
                threadId: thread.id,
                runId: item.runId,
                nodeId: item.nodeId,
                role: item.type === "user_message" ? "user" : "assistant",
                text: item.text,
                attachments: item.attachments ?? [],
                streaming: item.type === "assistant_message" && item.streaming,
                createdBy: item.type === "user_message" ? item.createdBy : "agent",
                creationSource: "web",
                createdAt: item.startedAt ?? item.updatedAt,
                updatedAt: item.updatedAt,
                ...(item.type === "user_message" && item.context ? { context: item.context } : {}),
              },
            ]
          : [],
      ),
    ],
    plans: thread.items.flatMap((item) =>
      item.type === "todo_list"
        ? [
            {
              id: item.planId,
              threadId: thread.id,
              runId: item.runId,
              nodeId: NodeId.make(`${item.runId}-node`),
              kind: "todo_list" as const,
              status: item.steps.every((step) => step.status === "completed")
                ? ("completed" as const)
                : ("active" as const),
              steps: item.steps,
            },
          ]
        : [],
    ),
    turnItems: [...thread.items],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems,
    updatedAt: shell.updatedAt,
  };
}

export function createFixtures(): DemoThread[] {
  return [
    {
      id: "demo-feature",
      title: "Add a command menu",
      scenario: "feature",
      settled: false,
      projectIndex: 0,
    },
    {
      id: "demo-bugfix",
      title: "Fix duplicate search results",
      scenario: "bugfix",
      settled: false,
      projectIndex: 0,
    },
    {
      id: "demo-review",
      title: "Review the autosave changes",
      scenario: "review",
      settled: true,
      projectIndex: 1,
    },
    {
      id: "demo-design",
      title: "Design an accessible empty state",
      scenario: "design-build",
      settled: false,
      projectIndex: 1,
    },
    {
      id: "demo-tour",
      title: "Tour the project",
      scenario: "tour",
      settled: true,
      projectIndex: 0,
    },
    {
      id: "demo-empty",
      title: "Explore the workspace",
      scenario: "feature",
      settled: false,
      projectIndex: 1,
    },
  ].map(({ id, title, scenario, settled, projectIndex }) => {
    const threadId = ThreadId.make(id);
    const runId = RunId.make(`${id}-run-1`);
    const selected = scenarioFor(scenario);
    const activity = id === "demo-empty" ? [] : replayActivityItems(threadId, runId, 1, selected);
    const items: OrchestrationV2TurnItem[] =
      id === "demo-empty"
        ? []
        : [
            userItem(threadId, runId, `${id}-user`, 0, selected.prompt),
            ...activity,
            assistantItem(
              threadId,
              runId,
              `${id}-assistant`,
              activity.length + 1,
              selected.introduction + "\n\n" + selected.answer,
            ),
          ];
    return {
      id: threadId,
      projectId: projects[projectIndex]!.id,
      title,
      modelSelection: MODEL,
      settled,
      continuation: selected.next,
      runs: items.length ? [run(threadId, runId, 1, `${id}-user`)] : [],
      items,
    };
  });
}

export const files: Readonly<Record<string, string>> = {
  "README.md":
    "# Interactive T3 Code demo\n\nThis fictional workspace lives entirely in your browser. Choose a provider and model, then send a message to play the next scripted scenario. Refresh to reset.\n",
  "package.json": '{"name":"orbit","scripts":{"test":"vitest run","dev":"vite"},"private":true}',
  "src/App.tsx":
    "export function App() { return <main><h1>Orbit</h1><p>Your ideas, in motion.</p></main>; }\n",
  "src/CommandMenu.tsx":
    'export function CommandMenu() { return <Command label="Jump to a project or thread" />; }\n',
  "src/search.ts": "export const uniqueResults = <T,>(items: T[]) => [...new Set(items)];\n",
  "src/autosave.ts":
    "export function autosave(save: () => void) { return setTimeout(save, 300); }\n",
  "src/schema.ts": "export const version = 1;\n",
  "src/math.ts":
    "export const clamp = (n: number, min: number, max: number) => Math.min(n, max);\n",
  "src/EmptyState.tsx": "export function EmptyState() { return null; }\n",
};
