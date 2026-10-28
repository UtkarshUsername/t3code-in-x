import type { OrchestrationV2UserInputQuestion } from "@t3tools/contracts";

export type DemoStep =
  | { type: "reasoning"; text: string }
  | { type: "read"; path: string }
  | { type: "plan"; steps: readonly string[]; current: number }
  | { type: "edit"; file: string; diff: string }
  | { type: "command"; input: string; output: string; exitCode?: number }
  | { type: "question"; questions: readonly OrchestrationV2UserInputQuestion[] };

export interface DemoTurn {
  introduction: string;
  answer: string;
  steps: readonly DemoStep[];
  next?: DemoTurn;
}

interface DemoScenario extends DemoTurn {
  id: string;
  name: string;
  prompt: string;
}

const codingScenarios = [
  {
    id: "feature",
    name: "Build a feature",
    prompt: "Add a command menu so I can jump between projects and threads.",
    introduction:
      "I'll inspect the existing navigation, add the command menu, and check keyboard behavior.",
    command: "vp test run src/command-menu.test.ts",
    file: "src/CommandMenu.tsx",
    answer:
      "Added a command menu with **project and thread search**.\n\n- Open it with `Ctrl+K` or `Cmd+K`.\n- Navigate results with the arrow keys and press Enter to select.\n- Escape closes the menu and restores focus.\n\nThe focused checks passed.\n\n*This is a scripted replay in a fictional workspace. Send another message to explore the next scenario.*",
    diff: 'diff --git a/src/CommandMenu.tsx b/src/CommandMenu.tsx\nnew file mode 100644\n--- /dev/null\n+++ b/src/CommandMenu.tsx\n@@ -0,0 +1,4 @@\n+export function CommandMenu() {\n+  return <Command label="Jump to a project or thread" />;\n+}\n+\n',
  },
  {
    id: "bugfix",
    name: "Fix a bug",
    prompt: "Search sometimes shows the same result twice. Find the cause and fix it.",
    introduction:
      "I'll trace how results merge, reproduce the duplicate, and fix it at the source.",
    command: "vp test run src/search.test.ts",
    file: "src/search.ts",
    answer:
      "Fixed duplicate search results by deduplicating on the stable result ID before ranking.\n\nThe regression case covers overlapping title and content matches. **All 8 search tests pass.**\n\n```ts\nconst unique = new Map(results.map(result => [result.id, result]));\nreturn rank([...unique.values()]);\n```\n\n*This is a scripted replay. Your prompt is kept locally for this visit; no model or backend is contacted.*",
    diff: "diff --git a/src/search.ts b/src/search.ts\n--- a/src/search.ts\n+++ b/src/search.ts\n@@ -1,1 +1,4 @@\n-return rank(results);\n+const unique = new Map(\n+  results.map(result => [result.id, result]),\n+);\n+return rank([...unique.values()]);\n",
  },
  {
    id: "review",
    name: "Review changes",
    prompt: "Review the autosave changes and point out any correctness issues.",
    introduction:
      "I'll read the autosave implementation and check cancellation, ordering, and error handling.",
    command: "vp test run src/autosave.test.ts",
    file: "src/autosave.ts",
    answer:
      "Found and fixed one ordering issue: an older save could overwrite a newer edit.\n\nThe save sequence now ignores stale completions, and unmount cancels pending work.\n\n| Case | Result |\n| --- | --- |\n| Rapid edits | Latest revision wins |\n| Navigation during save | Pending work cancelled |\n| Failed request | Draft remains available |\n\n**The focused checks pass.**\n\n*This is a simulated review using a fictional project.*",
    diff: "diff --git a/src/autosave.ts b/src/autosave.ts\n--- a/src/autosave.ts\n+++ b/src/autosave.ts\n@@ -1,1 +1,4 @@\n-await save(draft);\n+const revision = ++latestRevision;\n+await save(draft);\n+if (revision !== latestRevision) return;\n+markSaved(revision);\n",
  },
] as const;

const checklist = [
  "Inspect the existing behavior",
  "Make the smallest change",
  "Run focused tests",
];
const plan = (current: number): DemoStep => ({ type: "plan", steps: checklist, current });
const command = (input: string, output = "✓ Focused checks passed (simulated)"): DemoStep => ({
  type: "command",
  input,
  output,
});
const migration = {
  type: "edit",
  file: "src/schema.ts",
  diff: "diff --git a/src/schema.ts b/src/schema.ts\n--- a/src/schema.ts\n+++ b/src/schema.ts\n@@ -1 +1,2 @@\n export const version = 1;\n+export const indexes = ['notes.updatedAt'];\n",
} satisfies DemoStep;

export const scenarios: readonly DemoScenario[] = [
  ...codingScenarios.map((scenario): DemoScenario => ({
    ...scenario,
    steps: [
      { type: "reasoning", text: scenario.introduction },
      ...(scenario.id === "feature" ? [plan(0)] : []),
      { type: "read", path: scenario.id === "feature" ? "package.json" : scenario.file },
      ...(scenario.id === "feature" ? [plan(1)] : []),
      { type: "edit", file: scenario.file, diff: scenario.diff },
      ...(scenario.id === "feature" ? [plan(2)] : []),
      command(scenario.command),
      ...(scenario.id === "feature" ? [plan(3)] : []),
    ],
  })),
  {
    id: "migration",
    name: "Apply a migration",
    prompt: "Add an updated-at index to the notes schema.",
    introduction: "I'll inspect the schema, add the index, and run the migration checks.",
    steps: [
      { type: "read", path: "src/schema.ts" },
      migration,
      command("vp test run src/schema.test.ts"),
    ],
    answer:
      "Added the **updated-at index**. The simulated migration checks pass.\n\nNo real files or database were changed.",
  },
  {
    id: "question",
    name: "Choose a test strategy",
    prompt: "Help choose the test strategy for the notes editor.",
    introduction: "I'll ask which behavior matters most before recommending a test strategy.",
    steps: [
      {
        type: "reasoning",
        text: "The editor has both a parser and an interactive preview. A useful recommendation depends on which surface the user wants to prioritize.",
      },
      {
        type: "question",
        questions: [
          {
            id: "test-focus",
            header: "Test focus",
            question: "Which part of the notes editor should we prioritize?",
            options: [
              {
                label: "Parser correctness",
                description: "Start with fast unit tests for malformed and nested Markdown.",
              },
              {
                label: "Editor interactions",
                description: "Start with typing, selection, and keyboard navigation.",
              },
            ],
            allowCustomAnswer: true,
            required: true,
          },
        ],
      },
      { type: "read", path: "package.json" },
    ],
    answer:
      "Your selection is recorded below. Keep the first suite focused on that behavior, then add a small integration check for the editor and preview together.\n\nThis was a local, scripted clarification.",
  },
  {
    id: "tour",
    name: "Explore a project",
    prompt: "Give me a quick tour of the project without changing anything.",
    introduction: "I'll inspect the manifest and app entry point without editing files.",
    steps: [
      { type: "read", path: "package.json" },
      { type: "read", path: "src/App.tsx" },
    ],
    answer:
      "## Project tour\n\n| File | Purpose |\n| --- | --- |\n| `package.json` | Development and test scripts |\n| `src/App.tsx` | The application entry view |\n| `src/search.ts` | Search result handling |\n\nNo files were changed.",
  },
  {
    id: "test-repair",
    name: "Repair a failing test",
    prompt: "Investigate the failing clamp test and fix the boundary condition.",
    introduction:
      "I'll reproduce the boundary failure, inspect the helper, and rerun the test after fixing it.",
    steps: [
      {
        type: "reasoning",
        text: "The boundary test should distinguish clamping from wrapping. Reproduce the failure before changing the helper.",
      },
      {
        type: "command",
        input: "vp test run src/math.test.ts",
        output: "FAIL clamp(-3, 0, 10)\nExpected: 0\nReceived: -3\n1 failed, 11 passed (simulated)",
        exitCode: 1,
      },
      { type: "read", path: "src/math.ts" },
      {
        type: "edit",
        file: "src/math.ts",
        diff: "diff --git a/src/math.ts b/src/math.ts\n--- a/src/math.ts\n+++ b/src/math.ts\n@@ -1 +1 @@\n-export const clamp = (n: number, min: number, max: number) => Math.min(n, max);\n+export const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), max);\n",
      },
      command("vp test run src/math.test.ts", "✓ 12 tests passed (simulated)"),
    ],
    answer:
      "Fixed the missing lower-bound check.\n\n```ts\nclamp(-3, 0, 10); // 0\nclamp(12, 0, 10); // 10\n```\n\nThe failing regression now passes alongside the other 11 tests.",
  },
  {
    id: "design-build",
    name: "Design, then build",
    prompt: "Design an accessible empty state. We'll implement it in the next message.",
    introduction: "I'll inspect the app and propose a small empty state before we implement it.",
    steps: [{ type: "read", path: "src/App.tsx" }],
    answer:
      "## Empty-state design\n\n- A clear heading: **No notes yet**.\n- One short explanation.\n- A keyboard-accessible **Create note** button.\n\nSend another message to play the implementation turn of this same scenario.",
    next: {
      introduction: "I'll implement the empty state we designed in the previous turn.",
      steps: [
        {
          type: "reasoning",
          text: "Continue the previous design: preserve the heading and one primary action, using a native button for keyboard access.",
        },
        {
          type: "edit",
          file: "src/EmptyState.tsx",
          diff: "diff --git a/src/EmptyState.tsx b/src/EmptyState.tsx\nnew file mode 100644\n--- /dev/null\n+++ b/src/EmptyState.tsx\n@@ -0,0 +1,4 @@\n+export function EmptyState() {\n+  return <section><h2>No notes yet</h2><p>Create your first note.</p>\n+    <button>Create note</button></section>;\n+}\n",
        },
        command("vp test run src/empty-state.test.ts"),
      ],
      answer:
        "Implemented the **empty state from our previous turn** with a semantic heading and native button. The simulated accessibility checks pass.\n\nThis completes the two-turn scenario. Your next message continues the scenario cycle.",
    },
  },
];

export function scenarioFor(id: string) {
  return scenarios.find((scenario) => scenario.id === id) ?? scenarios[0]!;
}
