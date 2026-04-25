import { useEffect, useState } from "react";
import { Check, ChevronDown, Code2, Cpu, Heart, Info, Sparkles } from "lucide-react";

import type {
  DynamicMemoryStructuredFallbackFormat,
  Model,
  Settings,
  SystemPromptTemplate,
} from "../../../core/storage/schemas";
import { readSettings, saveAdvancedSettings } from "../../../core/storage/repo";
import { listPromptTemplates } from "../../../core/prompts/service";
import { APP_COMPANION_SOUL_WRITER_TEMPLATE_ID } from "../../../core/prompts/constants";
import { getProviderIcon } from "../../../core/utils/providerIcons";
import { cn } from "../../design-tokens";
import { ModelSelectionBottomMenu } from "../../components/ModelSelectionBottomMenu";

type ModelSlot = "primary" | "fallback";

const FALLBACK_OPTIONS: Array<{
  value: DynamicMemoryStructuredFallbackFormat;
  title: string;
  description: string;
}> = [
  {
    value: "json",
    title: "JSON",
    description: "Compact structured output when tool calling is unavailable.",
  },
  {
    value: "xml",
    title: "XML",
    description: "Use when the model formats XML more reliably than JSON.",
  },
];

function ensureAdvancedSettings(settings: Settings): NonNullable<Settings["advancedSettings"]> {
  const advanced = settings.advancedSettings ?? {
    creationHelperEnabled: false,
    helpMeReplyEnabled: true,
    companionSoulWriterStructuredFallbackFormat: "json",
  };
  if (advanced.creationHelperEnabled === undefined) advanced.creationHelperEnabled = false;
  if (advanced.helpMeReplyEnabled === undefined) advanced.helpMeReplyEnabled = true;
  if (advanced.companionSoulWriterStructuredFallbackFormat === undefined) {
    advanced.companionSoulWriterStructuredFallbackFormat = "json";
  }
  settings.advancedSettings = advanced;
  return advanced;
}

export function CompanionSoulWriterPage() {
  const [isLoading, setIsLoading] = useState(true);
  const [models, setModels] = useState<Model[]>([]);
  const [defaultModelId, setDefaultModelId] = useState<string | null>(null);
  const [primaryModelId, setPrimaryModelId] = useState<string | null>(null);
  const [fallbackModelId, setFallbackModelId] = useState<string | null>(null);
  const [fallbackFormat, setFallbackFormat] =
    useState<DynamicMemoryStructuredFallbackFormat>("json");
  const [templates, setTemplates] = useState<SystemPromptTemplate[]>([]);
  const [selectedPromptTemplateId, setSelectedPromptTemplateId] = useState<string | null>(null);
  const [showModelMenu, setShowModelMenu] = useState<ModelSlot | null>(null);

  const loadData = async () => {
    try {
      const [settings, promptTemplates] = await Promise.all([readSettings(), listPromptTemplates()]);
      const advanced = ensureAdvancedSettings(settings);
      const textModels = settings.models.filter(
        (m) => !m.outputScopes || m.outputScopes.includes("text"),
      );
      setModels(textModels);
      setDefaultModelId(settings.defaultModelId ?? null);
      setPrimaryModelId(advanced.companionSoulWriterModelId ?? null);
      setFallbackModelId(advanced.companionSoulWriterFallbackModelId ?? null);
      setFallbackFormat(advanced.companionSoulWriterStructuredFallbackFormat ?? "json");
      setSelectedPromptTemplateId(advanced.companionSoulWriterPromptTemplateId ?? null);
      setTemplates(
        promptTemplates.filter((template) => template.promptType === "companionSoulWriter"),
      );
    } catch (error) {
      console.error("Failed to load companion soul writer settings:", error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, []);

  const updateAdvancedSettings = async (
    updater: (advanced: NonNullable<Settings["advancedSettings"]>) => void,
    errorMessage: string,
  ) => {
    try {
      const settings = await readSettings();
      const advanced = ensureAdvancedSettings(settings);
      updater(advanced);
      await saveAdvancedSettings(advanced);
    } catch (error) {
      console.error(errorMessage, error);
    }
  };

  const findModel = (id: string | null) =>
    id ? models.find((m) => m.id === id) ?? null : null;
  const primaryModel = findModel(primaryModelId);
  const fallbackModel = findModel(fallbackModelId);
  const defaultModel = findModel(defaultModelId);
  const appDefaultLabel = defaultModel
    ? `Use App Default (${defaultModel.displayName})`
    : "Use App Default";
  const noFallbackLabel = "No fallback model";

  const handlePrimaryModelChange = async (modelId: string | null) => {
    setPrimaryModelId(modelId);
    await updateAdvancedSettings((advanced) => {
      advanced.companionSoulWriterModelId = modelId ?? undefined;
    }, "Failed to save companion soul writer model:");
  };

  const handleFallbackModelChange = async (modelId: string | null) => {
    setFallbackModelId(modelId);
    await updateAdvancedSettings((advanced) => {
      advanced.companionSoulWriterFallbackModelId = modelId ?? undefined;
    }, "Failed to save companion soul writer fallback model:");
  };

  const handleFallbackFormatChange = async (value: DynamicMemoryStructuredFallbackFormat) => {
    setFallbackFormat(value);
    await updateAdvancedSettings((advanced) => {
      advanced.companionSoulWriterStructuredFallbackFormat = value;
    }, "Failed to save companion soul writer fallback format:");
  };

  const handlePromptSelection = async (templateId: string | null) => {
    setSelectedPromptTemplateId(templateId);
    await updateAdvancedSettings((advanced) => {
      advanced.companionSoulWriterPromptTemplateId = templateId ?? undefined;
    }, "Failed to save companion soul writer prompt:");
  };

  if (isLoading) return null;

  const renderModelButton = (
    label: string,
    selectedModel: Model | null,
    onClick: () => void,
    placeholderLabel: string,
  ) => (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full items-center justify-between rounded-xl border border-fg/10 bg-surface-el/20 px-3.5 py-3 text-left transition hover:bg-surface-el/30 focus:border-fg/25 focus:outline-none"
    >
      <div className="flex min-w-0 items-center gap-2">
        {selectedModel ? (
          getProviderIcon(selectedModel.providerId ?? "")
        ) : (
          <Cpu className="h-5 w-5 shrink-0 text-fg/40" />
        )}
        <span className={cn("truncate text-sm", selectedModel ? "text-fg" : "text-fg/50")}>
          {selectedModel ? selectedModel.displayName : placeholderLabel}
        </span>
      </div>
      <ChevronDown className="h-4 w-4 shrink-0 text-fg/40" aria-label={label} />
    </button>
  );

  return (
    <div className="flex min-h-screen flex-col">
      <main className="flex-1 px-4 pb-24 pt-4">
        <div className="mx-auto w-full max-w-5xl space-y-6">
          <div className="rounded-xl border border-accent/20 bg-accent/5 p-3">
            <div className="flex items-start gap-2">
              <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-accent" />
              <p className="text-xs leading-relaxed text-accent/80">
                Configure the model and prompt that draft Companion Soul profiles. Tool calling is
                attempted first; if unsupported, the writer falls back to{" "}
                <span className="font-mono">{fallbackFormat.toUpperCase()}</span> structured output.
                If the primary call fails entirely, the fallback model is retried once.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <div className="space-y-4">
              <h3 className="px-1 text-[10px] font-semibold uppercase tracking-[0.25em] text-fg/35">
                Generation
              </h3>

              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <div className="rounded-lg border border-accent/30 bg-accent/10 p-1.5">
                    <Cpu className="h-4 w-4 text-accent" />
                  </div>
                  <h3 className="text-sm font-semibold text-fg">Generation Model</h3>
                </div>

                {models.length > 0 ? (
                  renderModelButton(
                    "Generation model",
                    primaryModel,
                    () => setShowModelMenu("primary"),
                    appDefaultLabel,
                  )
                ) : (
                  <div className="rounded-xl border border-fg/10 bg-surface-el/20 px-4 py-3">
                    <p className="text-sm text-fg/50">No text-capable models configured.</p>
                  </div>
                )}
                <p className="px-1 text-xs text-fg/50">
                  Leave unset to use the app's default text model.
                </p>
              </div>

              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <div className="rounded-lg border border-secondary/30 bg-secondary/10 p-1.5">
                    <Cpu className="h-4 w-4 text-secondary" />
                  </div>
                  <h3 className="text-sm font-semibold text-fg">Fallback Model</h3>
                </div>

                {models.length > 0 ? (
                  renderModelButton(
                    "Fallback model",
                    fallbackModel,
                    () => setShowModelMenu("fallback"),
                    noFallbackLabel,
                  )
                ) : (
                  <div className="rounded-xl border border-fg/10 bg-surface-el/20 px-4 py-3">
                    <p className="text-sm text-fg/50">No text-capable models configured.</p>
                  </div>
                )}
                <p className="px-1 text-xs text-fg/50">
                  Used only if the primary model errors before producing tool calls or text. Leave
                  unset to disable retry.
                </p>
              </div>

              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <div className="rounded-lg border border-info/30 bg-info/10 p-1.5">
                    <Code2 className="h-4 w-4 text-info" />
                  </div>
                  <h3 className="text-sm font-semibold text-fg">Structured Fallback</h3>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  {FALLBACK_OPTIONS.map((option) => {
                    const active = fallbackFormat === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => void handleFallbackFormatChange(option.value)}
                        className={cn(
                          "flex flex-col items-start gap-2 rounded-xl border p-4 text-left transition",
                          active
                            ? "border-info/40 bg-info/10"
                            : "border-fg/10 bg-fg/5 hover:border-fg/20",
                        )}
                      >
                        <div className="flex w-full items-center justify-between">
                          <span
                            className={cn(
                              "text-sm font-semibold",
                              active ? "text-info" : "text-fg/80",
                            )}
                          >
                            {option.title}
                          </span>
                          {active && (
                            <div className="flex h-5 w-5 items-center justify-center rounded-full bg-info">
                              <Check className="h-3 w-3 text-fg" />
                            </div>
                          )}
                        </div>
                        <span className="text-[11px] leading-relaxed text-fg/50">
                          {option.description}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <p className="px-1 text-xs text-fg/50">
                  Used only when the model can't call tools directly.
                </p>
              </div>
            </div>

            <div className="space-y-4">
              <h3 className="px-1 text-[10px] font-semibold uppercase tracking-[0.25em] text-fg/35">
                Prompt Template
              </h3>

              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <div className="rounded-lg border border-rose-400/30 bg-rose-500/10 p-1.5">
                    <Heart className="h-4 w-4 text-rose-300" />
                  </div>
                  <h3 className="text-sm font-semibold text-fg">Soul Writer Prompt</h3>
                </div>

                <select
                  value={selectedPromptTemplateId ?? ""}
                  onChange={(e) => void handlePromptSelection(e.target.value || null)}
                  className="w-full appearance-none rounded-xl border border-fg/10 bg-surface-el/20 px-3.5 py-3 text-sm text-fg transition focus:border-fg/25 focus:outline-none"
                >
                  <option value="">App Default Prompt</option>
                  {templates
                    .filter((template) => template.id !== APP_COMPANION_SOUL_WRITER_TEMPLATE_ID)
                    .map((template) => (
                      <option key={template.id} value={template.id}>
                        {template.name}
                      </option>
                    ))}
                </select>

                <p className="px-1 text-xs leading-relaxed text-fg/50">
                  Override the default companion soul writer prompt. Manage templates in Settings →
                  Prompts.
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-start gap-3 rounded-xl border border-fg/10 bg-fg/[0.03] px-4 py-3.5">
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-fg/30" />
            <div className="text-[11px] leading-relaxed text-fg/45">
              <p>
                Open a Companion-mode character's editor and use{" "}
                <span className="font-medium text-fg/65">Generate from character</span> in the Soul
                tab to launch the writer with these defaults.
              </p>
            </div>
          </div>
        </div>
      </main>

      <ModelSelectionBottomMenu
        isOpen={showModelMenu === "primary"}
        onClose={() => setShowModelMenu(null)}
        title="Generation Model"
        models={models}
        selectedModelIds={primaryModelId ? [primaryModelId] : []}
        onSelectModel={(modelId) => {
          void handlePrimaryModelChange(modelId);
          setShowModelMenu(null);
        }}
        clearOption={{
          label: "Use App Default",
          description: defaultModel ? defaultModel.displayName : "No app default model configured",
          icon: Cpu,
          selected: !primaryModelId,
          onClick: () => {
            void handlePrimaryModelChange(null);
            setShowModelMenu(null);
          },
        }}
      />

      <ModelSelectionBottomMenu
        isOpen={showModelMenu === "fallback"}
        onClose={() => setShowModelMenu(null)}
        title="Fallback Model"
        models={models}
        selectedModelIds={fallbackModelId ? [fallbackModelId] : []}
        onSelectModel={(modelId) => {
          void handleFallbackModelChange(modelId);
          setShowModelMenu(null);
        }}
        clearOption={{
          label: "No fallback",
          description: "Disable fallback retry on primary failure",
          icon: Cpu,
          selected: !fallbackModelId,
          onClick: () => {
            void handleFallbackModelChange(null);
            setShowModelMenu(null);
          },
        }}
      />
    </div>
  );
}
