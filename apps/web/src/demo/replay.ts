import {
  NodeId,
  RunId,
  type MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2TurnItem,
  type OrchestrationV2Run,
  type OrchestrationV2UserMessageInputIntent,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  assistantItem,
  demoSessionId,
  replayStepItem,
  run,
  userItem,
  type DemoThread,
} from "./fixtures";
import { scenarios } from "./scenarios";

type Response = Extract<OrchestrationV2Command, { type: "runtime-request.respond" }>;
type Message = Extract<OrchestrationV2Command, { type: "message.dispatch" }>;
type QueueCommand = Extract<
  OrchestrationV2Command,
  {
    type:
      | "queue.resume"
      | "queued-run.start"
      | "queued-run.cancel"
      | "queued-run.edit"
      | "queued-run.reorder"
      | "queued-message.promote-to-steer";
  }
>;

export function createReplayPlayer(
  getThread: (id: ThreadId) => DemoThread,
  replace: (thread: DemoThread) => { sequence: number },
  firstScenario: number,
) {
  const playback = new Map<
    ThreadId,
    {
      timer?: ReturnType<typeof setTimeout>;
      resume?: ((response: Response) => void) | undefined;
    }
  >();
  let nextRun = 1;
  let nextScenario = firstScenario;

  const activeRun = (id: ThreadId) =>
    getThread(id).runs.find((run) => ["running", "waiting"].includes(run.status));
  const queuedRuns = (id: ThreadId) =>
    getThread(id)
      .runs.filter((run) => run.status === "queued")
      .toSorted((a, b) => (a.queuePosition ?? a.ordinal) - (b.queuePosition ?? b.ordinal));
  const stop = (id: ThreadId, holdQueue = true) => {
    clearTimeout(playback.get(id)?.timer);
    playback.delete(id);
    const thread = getThread(id);
    const at = DateTime.nowUnsafe();
    return replace({
      ...thread,
      continuation: undefined,
      runs: thread.runs.map((run) =>
        ["running", "waiting"].includes(run.status)
          ? { ...run, status: "interrupted", completedAt: at }
          : run.status === "queued" && holdQueue
            ? { ...run, queueHeld: true }
            : run,
      ),
      items: thread.items.map((item) =>
        ["running", "waiting", "pending"].includes(item.status)
          ? {
              ...item,
              status: "interrupted",
              completedAt: at,
              ...("streaming" in item ? { streaming: false } : {}),
            }
          : item,
      ),
      requests: (thread.requests ?? []).map((request) =>
        request.status === "pending"
          ? { ...request, status: "cancelled", resolvedAt: at }
          : request,
      ),
    });
  };

  const start = (
    id: ThreadId,
    text: string,
    messageId: MessageId,
    model: ModelSelection = getThread(id).modelSelection,
    queuedRun?: OrchestrationV2Run,
    inputIntent: OrchestrationV2UserMessageInputIntent = "turn_start",
  ) => {
    const thread = getThread(id);
    if (thread.runs.some((run) => ["running", "waiting"].includes(run.status)))
      throw new Error("Stop the active replay before starting another turn.");
    const turn = thread.continuation ?? scenarios[nextScenario++ % scenarios.length]!;
    const runId = queuedRun?.id ?? RunId.make(`demo-run-${nextRun++}`);
    const queuedMessage = thread.queuedMessages?.find((message) => message.id === messageId);
    const at = DateTime.nowUnsafe();
    const state: NonNullable<ReturnType<typeof playback.get>> = {};
    playback.set(id, state);
    const active = () => playback.get(id) === state;
    const schedule = (action: () => void, delay = 550) => {
      state.timer = setTimeout(() => {
        if (active()) action();
      }, delay);
    };
    const put = (item: OrchestrationV2TurnItem) => {
      const current = getThread(id);
      const previous = current.items.find((candidate) => candidate.id === item.id);
      return replace({
        ...current,
        items: previous
          ? current.items.map((candidate) =>
              candidate.id === item.id ? { ...item, ordinal: previous.ordinal } : candidate,
            )
          : [...current.items, item],
      });
    };
    const runStatus = (status: "running" | "waiting" | "completed") => {
      const current = getThread(id);
      return replace({
        ...current,
        runs: current.runs.map((run) =>
          run.id === runId
            ? { ...run, status, completedAt: status === "completed" ? DateTime.nowUnsafe() : null }
            : run,
        ),
      });
    };
    const stream = (
      item: Extract<OrchestrationV2TurnItem, { type: "assistant_message" | "reasoning" }>,
      contents: string,
      done: () => void,
    ) => {
      const words = contents.match(/\S+\s*/g) ?? [];
      let position = 0;
      put({ ...item, text: "", streaming: true, status: "running", completedAt: null });
      const advance = () => {
        position += 5;
        const complete = position >= words.length;
        put({
          ...item,
          text: words.slice(0, position).join(""),
          streaming: !complete,
          status: complete ? "completed" : "running",
          updatedAt: DateTime.nowUnsafe(),
          completedAt: complete ? DateTime.nowUnsafe() : null,
        });
        if (complete) done();
        else schedule(advance, 110);
      };
      schedule(advance, 110);
    };
    let answers = "";
    const finish = (answer: string, success = true) => {
      const current = getThread(id);
      const item = assistantItem(id, runId, `${runId}-assistant`, current.items.length, "", true);
      stream(
        { ...item, startedAt: DateTime.nowUnsafe(), updatedAt: DateTime.nowUnsafe() },
        answer,
        () => {
          runStatus("completed");
          replace({ ...getThread(id), continuation: success ? turn.next : undefined });
          playback.delete(id);
          drain(id);
        },
      );
    };
    const advanceStep = (index: number) => {
      const step = turn.steps[index];
      if (!step) {
        finish(turn.answer + answers);
        return;
      }
      const item = replayStepItem(
        id,
        runId,
        getThread(id).items.length,
        step,
        DateTime.nowUnsafe(),
      );
      const next = () => schedule(() => advanceStep(index + 1));
      if (step.type === "reasoning" && item.type === "reasoning") {
        stream(item, step.text, next);
      } else if (item.type === "approval_request" || item.type === "user_input_request") {
        const pending = {
          ...item,
          nodeId: NodeId.make(`${runId}-node`),
          status: "waiting" as const,
          completedAt: null,
        };
        put(pending);
        const current = getThread(id);
        replace({
          ...current,
          requests: [
            ...(current.requests ?? []),
            {
              id: item.requestId,
              nodeId: pending.nodeId,
              providerTurnId: null,
              nativeRequestRef: null,
              kind: item.type === "approval_request" ? item.requestKind : "user_input",
              status: "pending",
              responseCapability: {
                type: "live",
                providerSessionId: demoSessionId(id, getThread(id).modelSelection.instanceId),
              },
              createdAt: DateTime.nowUnsafe(),
              resolvedAt: null,
            },
          ],
        });
        runStatus("waiting");
        state.resume = (response) => {
          if (item.type === "approval_request" && response.decision === undefined)
            throw new Error("Choose whether to allow this simulated edit.");
          if (
            item.type === "user_input_request" &&
            item.questions.some(
              (question) =>
                question.required &&
                (response.answers?.[question.id] === undefined ||
                  response.answers[question.id] === ""),
            )
          )
            throw new Error("Answer the question before continuing.");
          state.resume = undefined;
          const accepted =
            item.type !== "approval_request" || response.decision?.startsWith("accept");
          const resolvedAt = DateTime.nowUnsafe();
          const current = getThread(id);
          replace({
            ...current,
            requests: (current.requests ?? []).map((request) =>
              request.id === item.requestId
                ? {
                    ...request,
                    status: "resolved",
                    resolvedAt,
                    ...(response.decision ? { decision: response.decision } : {}),
                    ...(response.answers ? { answers: response.answers } : {}),
                  }
                : request,
            ),
          });
          put({
            ...pending,
            status: accepted ? "completed" : "cancelled",
            completedAt: resolvedAt,
          });
          runStatus("running");
          if (!accepted) {
            finish(
              "You declined the simulated edit. No files were changed. Send another message to explore a new scenario.",
              false,
            );
          } else {
            if (response.answers)
              answers = `\n\nYour answer:\n\n\`\`\`json\n${JSON.stringify(response.answers, null, 2)}\n\`\`\``;
            next();
          }
        };
      } else if (step.type === "plan") {
        put(item);
        next();
      } else {
        put({
          ...item,
          status: "running",
          completedAt: null,
          ...(item.type === "dynamic_tool" ? { output: undefined } : {}),
          ...(item.type === "command_execution" ? { output: "", exitCode: undefined } : {}),
          ...(item.type === "file_change" ? { diffStr: undefined } : {}),
        });
        schedule(() => {
          put({ ...item, completedAt: DateTime.nowUnsafe(), updatedAt: DateTime.nowUnsafe() });
          next();
        }, 800);
      }
    };
    const startedRun: OrchestrationV2Run = {
      ...run(
        id,
        runId,
        Math.max(
          0,
          ...thread.runs.filter((run) => run.startedAt !== null).map((run) => run.ordinal),
        ) + 1,
        messageId,
        model,
      ),
      status: "running",
      requestedAt: queuedRun?.requestedAt ?? at,
      startedAt: at,
      completedAt: null,
      queuePosition: null,
      queueHeld: false,
    };
    const result = replace({
      ...thread,
      modelSelection: model,
      settled: false,
      continuation: undefined,
      metadata: { ...thread.metadata, updatedAt: at, latestUserMessageAt: at },
      runs: [...thread.runs.filter((run) => run.id !== runId), startedRun],
      queuedMessages: (thread.queuedMessages ?? []).filter((message) => message.id !== messageId),
      items: [
        ...thread.items,
        {
          ...userItem(id, runId, messageId, thread.items.length, text),
          inputIntent,
          startedAt: at,
          updatedAt: at,
          completedAt: at,
          attachments: queuedMessage?.attachments ?? [],
          ...(queuedMessage?.context ? { context: queuedMessage.context } : {}),
        },
      ],
    });
    schedule(() => advanceStep(0), 250);
    return result;
  };

  const beginQueued = (
    id: ThreadId,
    queued: OrchestrationV2Run,
    inputIntent: OrchestrationV2UserMessageInputIntent = "turn_start",
  ) => {
    const message = getThread(id).queuedMessages?.find(
      (message) => message.id === queued.userMessageId,
    );
    if (!message) throw new Error("The queued demo message is missing.");
    return start(id, message.text, message.id, queued.modelSelection, queued, inputIntent);
  };
  const drain = (id: ThreadId) => {
    if (activeRun(id)) return;
    const next = queuedRuns(id)[0];
    if (next && !next.queueHeld) beginQueued(id, next);
  };
  const dispatchMessage = (command: Message) => {
    const id = command.threadId;
    const active = activeRun(id);
    if ("targetRunId" in command.dispatchMode && command.dispatchMode.targetRunId !== active?.id)
      throw new Error("That replay is no longer active.");
    const queueOnly =
      command.dispatchMode.type === "queue_after_active" ||
      command.dispatchMode.type === "defer_start";
    if (active && !queueOnly) stop(id, false);
    const thread = getThread(id);
    const at = DateTime.nowUnsafe();
    const queued: OrchestrationV2Run = {
      ...run(
        id,
        RunId.make(`demo-run-${nextRun++}`),
        thread.runs.length + 1,
        command.messageId,
        command.modelSelection ?? thread.modelSelection,
      ),
      status: "queued",
      requestedAt: at,
      startedAt: null,
      completedAt: null,
      providerThreadId: null,
      rootNodeId: null,
      activeAttemptId: null,
      queuePosition: (queuedRuns(id).at(-1)?.queuePosition ?? 0) + 1,
      queueHeld:
        command.dispatchMode.type === "defer_start" || queuedRuns(id).some((run) => run.queueHeld),
    };
    const result = replace({
      ...thread,
      settled: false,
      runs: [...thread.runs, queued],
      queuedMessages: [
        ...(thread.queuedMessages ?? []),
        {
          id: command.messageId,
          threadId: id,
          runId: queued.id,
          nodeId: null,
          role: "user",
          text: command.text,
          context: command.context,
          attachments: command.attachments,
          streaming: false,
          createdBy: command.createdBy,
          creationSource: command.creationSource,
          createdAt: at,
          updatedAt: at,
        },
      ],
    });
    if (!queueOnly) return beginQueued(id, queued, active ? "steer" : "turn_start");
    drain(id);
    return result;
  };
  const queueCommand = (command: QueueCommand) => {
    const id = command.threadId;
    if (command.type === "queue.resume") {
      const result = replace({
        ...getThread(id),
        runs: getThread(id).runs.map((run) =>
          run.status === "queued" ? { ...run, queueHeld: false } : run,
        ),
      });
      drain(id);
      return result;
    }
    const runId =
      command.type === "queued-message.promote-to-steer" ? command.queuedRunId : command.runId;
    const queued = queuedRuns(id).find((run) => run.id === runId);
    if (!queued) throw new Error("That message is no longer queued.");
    const thread = getThread(id);
    switch (command.type) {
      case "queued-run.cancel":
        return replace({
          ...thread,
          runs: thread.runs.map((run) =>
            run.id === runId
              ? {
                  ...run,
                  status: "cancelled",
                  completedAt: DateTime.nowUnsafe(),
                  queuePosition: null,
                }
              : run,
          ),
          queuedMessages: (thread.queuedMessages ?? []).filter(
            (message) => message.id !== queued.userMessageId,
          ),
        });
      case "queued-run.edit":
        return replace({
          ...thread,
          queuedMessages: (thread.queuedMessages ?? []).map((message) =>
            message.id === queued.userMessageId
              ? {
                  ...message,
                  text: command.text,
                  attachments: command.attachments ?? message.attachments,
                  ...(command.context ? { context: command.context } : {}),
                  updatedAt: DateTime.nowUnsafe(),
                }
              : message,
          ),
        });
      case "queued-run.reorder": {
        if (command.beforeRunId === runId) return replace(thread);
        const order = queuedRuns(id).filter((run) => run.id !== runId);
        const before =
          command.beforeRunId === null
            ? order.length
            : order.findIndex((run) => run.id === command.beforeRunId);
        if (before < 0) throw new Error("The queue destination is no longer available.");
        order.splice(before, 0, queued);
        return replace({
          ...thread,
          runs: thread.runs.map((run) =>
            run.status === "queued"
              ? { ...run, queuePosition: order.findIndex((queued) => queued.id === run.id) + 1 }
              : run,
          ),
        });
      }
      case "queued-message.promote-to-steer":
        if (activeRun(id)?.id !== command.targetRunId)
          throw new Error("That replay is no longer active.");
        stop(id, false);
        return beginQueued(id, queued, "promoted_queued_to_steer");
      case "queued-run.start":
        if (activeRun(id))
          throw new Error("Steer or stop the active replay before sending this message now.");
        return beginQueued(id, queued);
    }
  };

  const respond = (id: ThreadId, requestId: RuntimeRequestId, response: Response) => {
    const pending = getThread(id).requests?.find(
      (request) => request.id === requestId && request.status === "pending",
    );
    const resume = playback.get(id)?.resume;
    if (!pending || !resume)
      throw new Error("This demo request is no longer waiting for an answer.");
    resume(response);
    return replace(getThread(id));
  };

  return {
    start,
    stop,
    respond,
    dispatchMessage,
    queueCommand,
    interrupt: (id: ThreadId, holdQueue: boolean) => {
      const result = stop(id, holdQueue);
      if (!holdQueue) drain(id);
      return result;
    },
    dispose: () => {
      for (const state of playback.values()) clearTimeout(state.timer);
      playback.clear();
    },
  };
}
