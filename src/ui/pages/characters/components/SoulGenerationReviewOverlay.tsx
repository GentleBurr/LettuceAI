import { useEffect, useMemo, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Brain,
  Check,
  ChevronDown,
  Compass,
  Loader2,
  Shield,
  SlidersHorizontal,
  Sparkles,
  X,
} from "lucide-react";
import type { CompanionConfig } from "../../../../core/storage/schemas";
import { cn, interactive, radius, spacing, typography } from "../../../design-tokens";
import { mergeCompanionSoulDraft } from "../../../../core/companion/soul";
import { normalizeCompanionConfig } from "../utils/companionDefaults";

type SoulTextKey =
  | "essence"
  | "voice"
  | "relationalStyle"
  | "vulnerabilities"
  | "habits"
  | "boundaries";

type AffectKey = keyof CompanionConfig["soul"]["baselineAffect"];
type RegulationKey = keyof CompanionConfig["soul"]["regulationStyle"];
type RelationshipKey = keyof CompanionConfig["relationshipDefaults"];

interface SoulGenerationReviewOverlayProps {
  isOpen: boolean;
  baseline: CompanionConfig;
  draft: Partial<CompanionConfig> | null;
  direction: string;
  onDirectionChange: (next: string) => void;
  onApply: (next: CompanionConfig) => void;
  onCancel: () => void;
  onRegenerate: () => void;
  regenerating?: boolean;
}

const TEXT_FIELDS: Array<{ key: SoulTextKey; label: string; rows: number }> = [
  { key: "essence", label: "Essence", rows: 3 },
  { key: "voice", label: "Inner Voice", rows: 3 },
  { key: "relationalStyle", label: "Relational Style", rows: 3 },
  { key: "vulnerabilities", label: "Vulnerabilities", rows: 2 },
  { key: "habits", label: "Habits", rows: 2 },
  { key: "boundaries", label: "Boundaries", rows: 2 },
];

const AFFECT_LABELS: Record<AffectKey, [string, string, string]> = {
  warmth: ["Warmth", "Cold", "Affectionate"],
  trust: ["Trust", "Guarded", "Open"],
  calm: ["Calm", "Anxious", "Steady"],
  vulnerability: ["Vulnerability", "Walled", "Exposed"],
  longing: ["Longing", "Content", "Yearning"],
  hurt: ["Hurt", "Healed", "Tender"],
  tension: ["Tension", "Relaxed", "Wound up"],
  irritation: ["Irritation", "Patient", "Easily set off"],
  affectionIntensity: ["Affection", "Restrained", "Effusive"],
  reassuranceNeed: ["Reassurance Need", "Self-soothing", "Needs words"],
};

const REGULATION_LABELS: Record<RegulationKey, [string, string, string]> = {
  suppression: ["Suppression", "Expresses", "Hides"],
  volatility: ["Volatility", "Even-keeled", "Reactive"],
  recoverySpeed: ["Recovery Speed", "Slow", "Fast"],
  conflictAvoidance: ["Conflict Avoidance", "Engages", "Withdraws"],
  reassuranceSeeking: ["Reassurance Seeking", "Independent", "Asks often"],
  protestBehavior: ["Protest Behavior", "Quiet", "Loud"],
  emotionalTransparency: ["Transparency", "Opaque", "Reveals"],
  attachmentActivation: ["Attachment Activation", "Detached", "Triggers easily"],
  pride: ["Pride", "Bends", "Holds line"],
};

const RELATIONSHIP_LABELS: Record<RelationshipKey, [string, string, string]> = {
  closeness: ["Starting Closeness", "Strangers", "Intimate"],
  trust: ["Starting Trust", "Wary", "Trusting"],
  affection: ["Starting Affection", "Neutral", "Affectionate"],
  tension: ["Starting Tension", "Easy", "Charged"],
};

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function arrow(delta: number): string {
  if (delta > 0.02) return "↑";
  if (delta < -0.02) return "↓";
  return "→";
}

function countSliderChanges(
  baseline: Record<string, number>,
  draft: Record<string, number>,
): number {
  let n = 0;
  for (const key of Object.keys(baseline)) {
    if (Math.abs((draft[key] ?? baseline[key]) - baseline[key]) >= 0.02) n += 1;
  }
  return n;
}

function countTextChanges(
  baseline: CompanionConfig["soul"],
  draft: CompanionConfig["soul"],
): number {
  let n = 0;
  for (const { key } of TEXT_FIELDS) {
    if ((baseline[key] ?? "").trim() !== (draft[key] ?? "").trim()) n += 1;
  }
  return n;
}

const sectionLabel = cn(
  typography.label.size,
  typography.label.weight,
  typography.label.tracking,
  "uppercase text-fg/55",
);

export function SoulGenerationReviewOverlay({
  isOpen,
  baseline,
  draft,
  direction,
  onDirectionChange,
  onApply,
  onCancel,
  onRegenerate,
  regenerating = false,
}: SoulGenerationReviewOverlayProps) {
  const [working, setWorking] = useState<CompanionConfig>(() =>
    draft ? mergeCompanionSoulDraft(baseline, draft) : normalizeCompanionConfig(baseline),
  );
  const [openSection, setOpenSection] = useState<"affect" | "regulation" | "relationship" | null>(null);
  const [directionOpen, setDirectionOpen] = useState(false);

  // When a fresh draft arrives, replace working state with the merged draft.
  useEffect(() => {
    if (!isOpen) return;
    if (draft) {
      setWorking(mergeCompanionSoulDraft(baseline, draft));
    } else {
      setWorking(normalizeCompanionConfig(baseline));
    }
  }, [draft, baseline, isOpen]);

  const textChanges = useMemo(
    () => countTextChanges(baseline.soul, working.soul),
    [baseline.soul, working.soul],
  );
  const affectChanges = useMemo(
    () =>
      countSliderChanges(
        baseline.soul.baselineAffect as Record<string, number>,
        working.soul.baselineAffect as Record<string, number>,
      ),
    [baseline.soul.baselineAffect, working.soul.baselineAffect],
  );
  const regulationChanges = useMemo(
    () =>
      countSliderChanges(
        baseline.soul.regulationStyle as Record<string, number>,
        working.soul.regulationStyle as Record<string, number>,
      ),
    [baseline.soul.regulationStyle, working.soul.regulationStyle],
  );
  const relationshipChanges = useMemo(
    () =>
      countSliderChanges(
        baseline.relationshipDefaults as Record<string, number>,
        working.relationshipDefaults as Record<string, number>,
      ),
    [baseline.relationshipDefaults, working.relationshipDefaults],
  );
  const totalChanges = textChanges + affectChanges + regulationChanges + relationshipChanges;

  const updateText = (key: SoulTextKey, value: string) => {
    setWorking((prev) => ({ ...prev, soul: { ...prev.soul, [key]: value } }));
  };
  const updateAffect = (key: AffectKey, value: number) => {
    setWorking((prev) => ({
      ...prev,
      soul: {
        ...prev.soul,
        baselineAffect: { ...prev.soul.baselineAffect, [key]: value },
      },
    }));
  };
  const updateRegulation = (key: RegulationKey, value: number) => {
    setWorking((prev) => ({
      ...prev,
      soul: {
        ...prev.soul,
        regulationStyle: { ...prev.soul.regulationStyle, [key]: value },
      },
    }));
  };
  const updateRelationship = (key: RelationshipKey, value: number) => {
    setWorking((prev) => ({
      ...prev,
      relationshipDefaults: { ...prev.relationshipDefaults, [key]: value },
    }));
  };

  const renderSlider = (
    key: string,
    label: [string, string, string],
    value: number,
    onChange: (next: number) => void,
    baselineValue: number,
  ) => {
    const changed = Math.abs(value - baselineValue) >= 0.02;
    return (
      <div key={key} className={spacing.tight}>
        <div className="flex items-center justify-between">
          <span className="text-sm text-fg/80">{label[0]}</span>
          <span className={cn("text-[11px]", changed ? "text-accent" : "text-fg/45")}>
            {changed ? (
              <>
                {pct(baselineValue)}{" "}
                <span className="text-fg/40">{arrow(value - baselineValue)}</span>{" "}
                <span className="font-semibold text-fg">{pct(value)}</span>
              </>
            ) : (
              pct(value)
            )}
          </span>
        </div>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round(value * 100)}
          onChange={(event) => onChange(Number(event.target.value) / 100)}
          className="w-full accent-accent"
        />
        <div className="flex justify-between text-[10px] text-fg/40">
          <span>{label[1]}</span>
          <span>{label[2]}</span>
        </div>
      </div>
    );
  };

  const renderCollapsible = (
    id: "affect" | "regulation" | "relationship",
    Icon: typeof Brain,
    title: string,
    changeCount: number,
    body: React.ReactNode,
    iconChip: string,
  ) => {
    const open = openSection === id;
    return (
      <div
        className={cn(
          "overflow-hidden border border-fg/10 bg-fg/5",
          radius.lg,
          interactive.transition.default,
        )}
      >
        <button
          type="button"
          onClick={() => setOpenSection(open ? null : id)}
          aria-expanded={open}
          className="flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-fg/[0.07]"
        >
          <div className={cn("p-1.5 border", radius.md, iconChip)}>
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className={cn(typography.h3.size, typography.h3.weight, "text-fg")}>{title}</h3>
            <p className="mt-0.5 text-xs text-fg/45">
              {changeCount === 0
                ? "Unchanged"
                : `${changeCount} change${changeCount === 1 ? "" : "s"}`}
            </p>
          </div>
          {changeCount > 0 && (
            <span
              className={cn(
                "border border-accent/30 bg-accent/10 px-2 py-0.5 text-[10px] font-semibold text-accent",
                radius.full,
              )}
            >
              {changeCount}
            </span>
          )}
          <ChevronDown
            className={cn(
              "h-4 w-4 shrink-0 text-fg/40 transition-transform duration-150",
              open && "rotate-180",
            )}
          />
        </button>
        <div
          className={cn(
            "grid transition-[grid-template-rows] duration-200 ease-out",
            open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
          )}
        >
          <div className="overflow-hidden">
            <div className="border-t border-fg/10 p-3.5">{body}</div>
          </div>
        </div>
      </div>
    );
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            className="fixed inset-0 z-30 bg-black/40 backdrop-blur-sm"
            onClick={onCancel}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          />
          <motion.div
            initial={{ y: "100%" }}
            animate={{ y: 0 }}
            exit={{ y: "100%" }}
            transition={{ type: "spring", damping: 28, stiffness: 260 }}
            className={cn(
              "fixed inset-x-0 bottom-0 top-[max(48px,calc(72px+env(safe-area-inset-top)))] z-40 flex flex-col overflow-hidden border-t border-fg/15 bg-surface shadow-2xl",
              "rounded-t-2xl",
            )}
          >
            <div className="flex items-center gap-3 border-b border-fg/10 px-4 py-3">
              <div className={cn("border border-accent/30 bg-accent/10 p-1.5", radius.md)}>
                <Sparkles className="h-4 w-4 text-accent" />
              </div>
              <div className="min-w-0 flex-1">
                <div className={cn(typography.h3.size, typography.h3.weight, "text-fg")}>
                  Review generated soul
                </div>
                <div className={cn(typography.bodySmall.size, "text-fg/50")}>
                  {totalChanges === 0
                    ? "No differences from current."
                    : `${totalChanges} change${totalChanges === 1 ? "" : "s"} — edit anything before applying.`}
                </div>
              </div>
              <button
                type="button"
                onClick={onCancel}
                className={cn(
                  "p-1.5 text-fg/45 hover:bg-fg/5 hover:text-fg",
                  radius.md,
                  interactive.transition.fast,
                )}
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className={cn("flex-1 overflow-y-auto px-4 py-4", spacing.section)}>
              <div className="mx-auto w-full max-w-2xl space-y-5">
                <div className={spacing.field}>
                  <div className="flex items-center justify-between">
                    <label className={sectionLabel}>Identity</label>
                    {textChanges > 0 && (
                      <span className={cn(typography.caption.size, "text-accent/80")}>
                        {textChanges} edited
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-1 gap-4">
                    {TEXT_FIELDS.map((field) => {
                      const value = working.soul[field.key] ?? "";
                      const baseValue = (baseline.soul[field.key] ?? "").trim();
                      const changed = baseValue !== value.trim();
                      return (
                        <div key={field.key} className={spacing.field}>
                          <div className="flex items-center justify-between">
                            <label className="text-xs font-medium text-fg/70">{field.label}</label>
                            {changed && (
                              <span className="text-[10px] font-semibold uppercase tracking-wider text-accent/80">
                                Edited
                              </span>
                            )}
                          </div>
                          <textarea
                            value={value}
                            onChange={(e) => updateText(field.key, e.target.value)}
                            rows={field.rows}
                            className={cn(
                              "w-full resize-none border bg-surface-el/20 px-4 py-3 text-sm leading-relaxed text-fg placeholder-fg/40 backdrop-blur-xl",
                              radius.md,
                              interactive.transition.default,
                              "focus:bg-surface-el/30 focus:outline-none",
                              changed
                                ? "border-accent/30 focus:border-accent/45"
                                : "border-fg/10 focus:border-fg/30",
                            )}
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className={spacing.field}>
                  <label className={sectionLabel}>Tuning</label>
                  <div className={spacing.item}>
                    {renderCollapsible(
                      "affect",
                      Brain,
                      "Baseline Affect",
                      affectChanges,
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        {(Object.keys(AFFECT_LABELS) as AffectKey[]).map((k) =>
                          renderSlider(
                            k,
                            AFFECT_LABELS[k],
                            working.soul.baselineAffect[k],
                            (next) => updateAffect(k, next),
                            baseline.soul.baselineAffect[k],
                          ),
                        )}
                      </div>,
                      "border-info/30 bg-info/10 text-info",
                    )}
                    {renderCollapsible(
                      "regulation",
                      SlidersHorizontal,
                      "Regulation Style",
                      regulationChanges,
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        {(Object.keys(REGULATION_LABELS) as RegulationKey[]).map((k) =>
                          renderSlider(
                            k,
                            REGULATION_LABELS[k],
                            working.soul.regulationStyle[k],
                            (next) => updateRegulation(k, next),
                            baseline.soul.regulationStyle[k],
                          ),
                        )}
                      </div>,
                      "border-warning/30 bg-warning/10 text-warning",
                    )}
                    {renderCollapsible(
                      "relationship",
                      Shield,
                      "Relationship Defaults",
                      relationshipChanges,
                      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                        {(Object.keys(RELATIONSHIP_LABELS) as RelationshipKey[]).map((k) =>
                          renderSlider(
                            k,
                            RELATIONSHIP_LABELS[k],
                            working.relationshipDefaults[k],
                            (next) => updateRelationship(k, next),
                            baseline.relationshipDefaults[k],
                          ),
                        )}
                      </div>,
                      "border-secondary/30 bg-secondary/10 text-secondary",
                    )}
                  </div>
                </div>
              </div>
            </div>

            <AnimatePresence>
              {directionOpen && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.18 }}
                  className="overflow-hidden border-t border-fg/10 bg-surface-el/30"
                >
                  <div className="px-3 py-2">
                    <div className="mb-1 flex items-center justify-between px-0.5">
                      <label className="text-[10px] font-semibold uppercase tracking-[0.18em] text-fg/50">
                        Direction
                      </label>
                      <span className="text-[10px] font-mono text-fg/35">
                        Edits apply on next Regenerate
                      </span>
                    </div>
                    <textarea
                      value={direction}
                      onChange={(e) => onDirectionChange(e.target.value)}
                      rows={3}
                      autoFocus
                      placeholder='e.g. "Lean tsundere — guarded outside, soft once trusted. Less anxious."'
                      className={cn(
                        "w-full resize-none border border-fg/10 bg-surface-el/40 px-2.5 py-2 text-[12.5px] leading-relaxed text-fg outline-none",
                        radius.md,
                        interactive.transition.default,
                        "focus:border-fg/25",
                      )}
                    />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="flex items-center gap-2 border-t border-fg/10 bg-surface/95 px-3 py-2.5">
              <button
                type="button"
                onClick={() => setDirectionOpen((v) => !v)}
                className={cn(
                  "inline-flex items-center gap-1.5 border px-2.5 py-2 text-[12px] font-medium",
                  radius.md,
                  interactive.transition.fast,
                  direction.trim()
                    ? "border-info/30 bg-info/10 text-info"
                    : directionOpen
                      ? "border-fg/20 bg-fg/10 text-fg"
                      : "border-fg/10 bg-fg/5 text-fg/65 hover:bg-fg/10",
                )}
                title="Edit direction before regenerating"
              >
                <Compass className="h-3.5 w-3.5" />
                <span>Direction</span>
                {direction.trim() && <span className="h-1.5 w-1.5 rounded-full bg-info" />}
              </button>
              <button
                type="button"
                onClick={onRegenerate}
                disabled={regenerating}
                className={cn(
                  "inline-flex items-center gap-1.5 border border-fg/10 bg-fg/5 px-2.5 py-2 text-[12px] font-medium text-fg/70 hover:bg-fg/10 disabled:opacity-60",
                  radius.md,
                  interactive.transition.fast,
                )}
              >
                {regenerating ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
                Regenerate
              </button>
              <div className="flex-1" />
              <button
                type="button"
                onClick={onCancel}
                className={cn(
                  "border border-fg/10 bg-fg/5 px-2.5 py-2 text-[12px] font-medium text-fg/70 hover:bg-fg/10",
                  radius.md,
                  interactive.transition.fast,
                )}
              >
                Discard
              </button>
              <button
                type="button"
                onClick={() => onApply(working)}
                className={cn(
                  "inline-flex items-center gap-1.5 border border-accent/30 bg-accent/15 px-3.5 py-2 text-[12px] font-semibold text-accent hover:bg-accent/25",
                  radius.md,
                  interactive.transition.fast,
                )}
              >
                <Check className="h-3.5 w-3.5" />
                Apply
              </button>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
