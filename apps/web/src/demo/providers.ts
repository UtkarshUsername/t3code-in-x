import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ModelSelection,
  type ProviderInstanceConfig,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";

const model = (slug: string, name: string) =>
  ({
    slug,
    name,
    isCustom: false,
    capabilities: {
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Reasoning",
          type: "select",
          role: "reasoning",
          currentValue: "high",
          options: [
            { id: "low", label: "Low" },
            { id: "medium", label: "Medium" },
            { id: "high", label: "High", isDefault: true },
            { id: "xhigh", label: "Extra High" },
            { id: "max", label: "Max" },
          ],
        },
      ],
    },
  }) satisfies ServerProviderModel;

const codexModels = [
  model("gpt-6.2-sol", "GPT 6.2 Sol"),
  model("gpt-6.1-astra", "GPT 6.1 Astra"),
  model("gpt-6.1-luna", "GPT 6.1 Luna"),
  model("gpt-6.2-terra", "GPT 6.2 Terra"),
];
const claudeModels = [
  model("claude-fable-5.5", "Claude Fable 5.5"),
  model("claude-opus-5.7", "Claude Opus 5.7"),
  model("claude-sonnet-5.7", "Claude Sonnet 5.7"),
];
const grokModels = [model("grok-5", "Grok 5"), model("composer-4", "Composer 4")];
const museModels = [
  model("muse-wonder-1.2", "Muse Wonder 1.2"),
  model("muse-spark-1.4", "Muse Spark 1.4"),
];
const geminiModels = [
  model("gemini-4-carbon", "Gemini 4 Carbon"),
  model("gemini-4-boron", "Gemini 4 Boron"),
  model("gemini-argon-4.1-pro", "Gemini Argon 4.1 Pro"),
  model("gemini-3.5-pro", "Gemini 3.5 Pro"),
];
const openCodeModels = [
  model("big-pickle", "Big Pickle"),
  model("deepseek-v5", "DeepSeek v5"),
  model("glm-5.4", "GLM 5.4"),
  model("kimi-k3.2-pro", "Kimi K3.2 Pro"),
  ...codexModels,
  ...grokModels,
  ...museModels,
  ...geminiModels,
];

function provider(driver: string, displayName: string, models: ReadonlyArray<ServerProviderModel>) {
  const driverKind = ProviderDriverKind.make(driver);
  return {
    instanceId: defaultInstanceIdForDriver(driverKind),
    driver: driverKind,
    displayName,
    enabled: true,
    installed: true,
    version: "demo",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-28T09:00:00.000Z",
    models: models.map((entry, index) => ({ ...entry, isDefault: index === 0 })),
    slashCommands: [],
    skills: [],
  } satisfies ServerProvider;
}

// Match providerStatusCache's server order without importing server code into the browser.
export const demoProviders = [
  provider("codex", "Codex", codexModels),
  provider("claudeAgent", "Claude", claudeModels),
  provider("cursor", "Cursor", [...grokModels, ...claudeModels]),
  provider("grok", "Grok", grokModels),
  provider("opencode", "OpenCode", openCodeModels),
  provider("antigravity", "Antigravity", [
    ...geminiModels,
    model("claude-opus-5.5", "Claude Opus 5.5"),
  ]),
  provider("muse", "Muse", museModels),
  provider(
    "pi",
    "Pi",
    openCodeModels.filter((entry) => entry.slug !== "big-pickle"),
  ),
];

export const demoProviderInstances = Object.fromEntries(
  demoProviders.map((entry) => [
    entry.instanceId,
    { driver: entry.driver, displayName: entry.displayName, enabled: true },
  ]),
) satisfies Record<string, ProviderInstanceConfig>;

export const DEFAULT_DEMO_MODEL = {
  instanceId: demoProviders[0]!.instanceId,
  model: demoProviders[0]!.models[0]!.slug,
} satisfies ModelSelection;
