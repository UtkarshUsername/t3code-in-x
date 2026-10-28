import {
  NodeId,
  ProviderSessionId,
  RunId,
  type MessageId,
  type ModelSelection,
  type OrchestrationV2Command,
  type OrchestrationV2TurnItem,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { assistantItem, replayStepItem, run, userItem, type DemoThread } from "./fixtures";
import { scenarios } from "./scenarios";

type Response = Extract<OrchestrationV2Command, { type: "runtime-request.respond" }>;

export function createReplayPlayer(
  getThread: (id: ThreadId) => DemoThread,
  replace: (thread: DemoThread) => { sequence: number },
  random: () => number,
) {
  const playback = new Map<
    ThreadId,
    {
      timer?: ReturnType<typeof setTimeout>;
      resume?: ((response: Response) => void) | undefined;
    }
  >();
  let nextRun = 1;

  const stop = (id: ThreadId) => {
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
  ) => {
    const thread = getThread(id);
    if (thread.runs.some((run) => ["running", "waiting"].includes(run.status)))
      throw new Error("Stop the active replay before starting another turn.");
    const turn = thread.continuation ?? scenarios[Math.floor(random() * scenarios.length)]!;
    const runId = RunId.make(`demo-run-${nextRun++}`);
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
                providerSessionId: ProviderSessionId.make(`demo-session-${id}`),
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
    const result = replace({
      ...thread,
      modelSelection: model,
      settled: false,
      continuation: undefined,
      metadata: { ...thread.metadata, updatedAt: at, latestUserMessageAt: at },
      runs: [
        ...thread.runs,
        {
          ...run(id, runId, thread.runs.length + 1, messageId, model),
          status: "running",
          requestedAt: at,
          startedAt: at,
          completedAt: null,
        },
      ],
      items: [
        ...thread.items,
        {
          ...userItem(id, runId, messageId, thread.items.length, text),
          startedAt: at,
          updatedAt: at,
          completedAt: at,
        },
      ],
    });
    schedule(() => advanceStep(0), 250);
    return result;
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
    dispose: () => {
      for (const state of playback.values()) clearTimeout(state.timer);
      playback.clear();
    },
  };
}
