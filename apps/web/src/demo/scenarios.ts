export const scenarios = [
  {
    id: "feature",
    name: "Build a feature",
    prompt: "Add a command menu so I can jump between projects and threads.",
    introduction:
      "I'll inspect the existing navigation, add the command menu, and check keyboard behavior.",
    command: "vp test run src/command-menu.test.ts",
    file: "src/CommandMenu.tsx",
    answer:
      "Added a command menu with **project and thread search**.\n\n- Open it with `Ctrl+K` or `Cmd+K`.\n- Navigate results with the arrow keys and press Enter to select.\n- Escape closes the menu and restores focus.\n\nThe focused checks passed.\n\n*This is a scripted replay in a fictional workspace. Send another message to explore a random scenario.*",
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

export function scenarioFor(id: string) {
  return scenarios.find((scenario) => scenario.id === id) ?? scenarios[0];
}
