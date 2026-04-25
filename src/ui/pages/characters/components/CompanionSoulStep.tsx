import { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { AlertCircle, ArrowLeft, Heart, RefreshCcw } from "lucide-react";
import type { CompanionConfig, Scene } from "../../../../core/storage/schemas";
import { generateCompanionSoulDraft } from "../../../../core/companion/soul";
import {
  cn,
  interactive,
  radius,
  spacing,
  typography,
} from "../../../design-tokens";
import { CompanionSoulEditor } from "./CompanionSoulEditor";
import { SoulGenerationReviewOverlay } from "./SoulGenerationReviewOverlay";
import { normalizeCompanionConfig } from "../utils/companionDefaults";

interface ModelOption {
  id: string;
  displayName: string;
}

interface CompanionSoulStepProps {
  name: string;
  definition: string;
  description: string;
  scenes: Scene[];
  companion: CompanionConfig | null | undefined;
  selectedModelId: string | null;
  models?: ModelOption[];
  onCompanionChange: (value: CompanionConfig) => void;
  onBack: () => void;
  onContinue: () => void;
}

function openingContextFromScenes(scenes: Scene[]): string {
  return scenes
    .map((scene) => [scene.content, scene.direction].filter(Boolean).join("\n"))
    .filter((value) => value.trim().length > 0)
    .join("\n\n");
}

export function CompanionSoulStep({
  name,
  definition,
  description,
  scenes,
  companion,
  selectedModelId,
  models,
  onCompanionChange,
  onBack,
  onContinue,
}: CompanionSoulStepProps) {
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Partial<CompanionConfig> | null>(null);
  const [direction, setDirection] = useState("");

  const value = normalizeCompanionConfig(companion);

  const generationDisabledReason = useMemo<string | null>(() => {
    if (!name.trim()) return "Add a name first.";
    if (!definition.trim()) return "Add a definition first.";
    return null;
  }, [name, definition]);

  const modelLabel = useMemo(() => {
    if (!selectedModelId) return null;
    return models?.find((m) => m.id === selectedModelId)?.displayName ?? null;
  }, [selectedModelId, models]);

  const runGeneration = async () => {
    if (generationDisabledReason) {
      setError(generationDisabledReason);
      return;
    }
    setGenerating(true);
    setError(null);
    try {
      const next = await generateCompanionSoulDraft({
        characterName: name,
        characterDefinition: definition,
        characterDescription: description,
        openingContext: openingContextFromScenes(scenes),
        currentSoul: value,
        userNotes: direction.trim() || null,
        modelId: selectedModelId,
      });
      setDraft(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
    }
  };

  const handleApply = (next: CompanionConfig) => {
    onCompanionChange(next);
    setDraft(null);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -16 }}
      transition={{ duration: 0.2, ease: "easeOut" }}
      className={spacing.section}
    >
      <div className={spacing.tight}>
        <div className="flex items-center gap-2">
          <div className={cn("border border-rose-400/30 bg-rose-500/10 p-1.5", radius.md)}>
            <Heart className="h-4 w-4 text-rose-300" />
          </div>
          <h2 className={cn(typography.h1.size, typography.h1.weight, "text-fg")}>
            Companion Soul
          </h2>
        </div>
        <p className={cn(typography.body.size, "text-fg/50")}>
          Shape who they are underneath. Generation uses the opening context you set in the previous
          step.
        </p>
      </div>

      <CompanionSoulEditor
        companion={value}
        onChange={onCompanionChange}
        onGenerate={runGeneration}
        generating={generating}
        generationDisabledReason={generationDisabledReason}
        modelLabel={modelLabel}
        direction={direction}
        onDirectionChange={setDirection}
      />

      {error && (
        <div
          className={cn(
            "flex items-start gap-2 border border-danger/30 bg-danger/10 px-3 py-2.5 text-sm text-danger",
            radius.lg,
          )}
        >
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <button
            type="button"
            onClick={() => {
              setError(null);
              void runGeneration();
            }}
            className={cn(
              "inline-flex items-center gap-1 border border-danger/30 bg-danger/15 px-2 py-1 text-xs font-medium text-danger hover:bg-danger/25",
              radius.md,
              interactive.transition.fast,
            )}
          >
            <RefreshCcw className="h-3 w-3" />
            Retry
          </button>
        </div>
      )}

      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
        <button
          type="button"
          onClick={onBack}
          className={cn(
            "inline-flex items-center justify-center gap-2 border border-fg/10 bg-fg/5 px-4 py-3 text-sm text-fg/80",
            radius.md,
            interactive.transition.fast,
            interactive.active.scale,
            "hover:border-fg/25 hover:bg-fg/10",
          )}
        >
          <ArrowLeft className="h-4 w-4" />
          Back
        </button>
        <button
          type="button"
          onClick={onContinue}
          disabled={generating}
          className={cn(
            "inline-flex items-center justify-center gap-2 border border-accent/40 bg-accent/20 px-4 py-3 text-sm font-semibold text-accent hover:border-accent/55 hover:bg-accent/30 disabled:cursor-not-allowed disabled:opacity-50",
            radius.md,
            interactive.transition.fast,
            interactive.active.scale,
          )}
        >
          Continue
        </button>
      </div>

      <SoulGenerationReviewOverlay
        isOpen={draft !== null}
        baseline={value}
        draft={draft}
        direction={direction}
        onDirectionChange={setDirection}
        onApply={handleApply}
        onCancel={() => setDraft(null)}
        onRegenerate={runGeneration}
        regenerating={generating}
      />
    </motion.div>
  );
}
