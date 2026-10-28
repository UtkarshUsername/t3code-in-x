import {
  MessageId,
  ProjectId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type ModelSelection,
  type OrchestrationProjectShell,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { scenarios, scenarioFor } from "./scenarios";
import { DEFAULT_DEMO_MODEL, demoProviders } from "./providers";

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

export function replayActivityItems(
  threadId: ThreadId,
  runId: RunId,
  ordinal: number,
  scenario: (typeof scenarios)[number],
  at = AT,
) {
  return [
    {
      ...base(threadId, runId, `${runId}-file`, ordinal),
      startedAt: at,
      updatedAt: at,
      completedAt: at,
      type: "file_change",
      fileName: scenario.file,
      additions: 4,
      deletions: 1,
      diffStr: scenario.diff,
    },
    {
      ...base(threadId, runId, `${runId}-command`, ordinal + 1),
      startedAt: at,
      updatedAt: at,
      completedAt: at,
      type: "command_execution",
      title: "Run focused tests",
      input: scenario.command,
      output: "✓ Focused checks passed (simulated)",
      exitCode: 0,
    },
  ] satisfies OrchestrationV2TurnItem[];
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
    providerThreadId: null,
    userMessageId: MessageId.make(userMessageId),
    rootNodeId: null,
    activeAttemptId: null,
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
}

export function shellOf(thread: DemoThread): OrchestrationV2ThreadShell {
  const latest = thread.runs.at(-1);
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
    activeProviderThreadId: ProviderThreadId.make(
      `demo-provider-${thread.id}-${thread.modelSelection.instanceId}`,
    ),
    lineage: { rootThreadId: thread.id, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: latest?.id ?? null,
    activeRunId: latest?.status === "running" ? latest.id : null,
    status: latest?.status ?? "idle",
    pendingRuntimeRequest: null,
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
  const driver = demoProviders.find(
    (provider) => provider.instanceId === thread.modelSelection.instanceId,
  )!.driver;
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
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [
      {
        id: shell.activeProviderThreadId!,
        driver,
        providerInstanceId: thread.modelSelection.instanceId,
        providerSessionId: null,
        appThreadId: thread.id,
        ownerNodeId: null,
        nativeThreadRef: { driver, nativeId: thread.id, strength: "strong" },
        nativeConversationHeadRef: null,
        status: shell.activeRunId === null ? "idle" : "active",
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
      },
    ],
    providerTurns: [],
    runtimeRequests: [],
    messages: [],
    plans: [],
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
      runs: items.length ? [run(threadId, runId, 1, `${id}-user`)] : [],
      items,
    };
  });
}

export const files: Readonly<Record<string, string>> = {
  "README.md":
    "# Interactive T3 Code demo\n\nThis fictional workspace lives entirely in your browser. Choose a provider and model, then send a message to play a random scripted scenario. Refresh to reset.\n",
  "package.json": '{"name":"orbit","scripts":{"test":"vitest run","dev":"vite"},"private":true}',
  "src/App.tsx":
    "export function App() { return <main><h1>Orbit</h1><p>Your ideas, in motion.</p></main>; }\n",
  "src/CommandMenu.tsx":
    'export function CommandMenu() { return <Command label="Jump to a project or thread" />; }\n',
  "src/search.ts": "export const uniqueResults = <T,>(items: T[]) => [...new Set(items)];\n",
  "src/autosave.ts":
    "export function autosave(save: () => void) { return setTimeout(save, 300); }\n",
};
