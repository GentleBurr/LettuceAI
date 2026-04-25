import { Download, Heart } from "lucide-react";
import { BottomMenu } from "./BottomMenu";
import { cn, interactive, radius, typography } from "../design-tokens";
import type { CompanionRequirement } from "../pages/characters/hooks/useCompanionRequirements";

interface MissingCompanionModelsSheetProps {
  isOpen: boolean;
  missing: CompanionRequirement[];
  onClose: () => void;
  onDownload: () => void;
}

export function MissingCompanionModelsSheet({
  isOpen,
  missing,
  onClose,
  onDownload,
}: MissingCompanionModelsSheetProps) {
  const count = missing.length;
  const subtitle =
    count === 1
      ? "Companion mode needs one more model before it can run. Skipping will switch this character back to Roleplay."
      : `Companion mode needs ${count} more models before it can run. Skipping will switch this character back to Roleplay.`;

  return (
    <BottomMenu isOpen={isOpen} onClose={onClose} title="Companion needs setup">
      <div className="flex flex-col gap-4 px-4 pb-2 pt-1">
        <div className="flex items-start gap-3">
          <div className={cn("border border-rose-400/30 bg-rose-500/10 p-2 text-rose-300", radius.lg)}>
            <Heart className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className={cn(typography.body.size, "text-fg")}>
              Companion mode needs some local models to analyze emotion, extract entities, route
              memories, and recall past context.
            </p>
            <p className={cn(typography.bodySmall.size, "mt-1 text-fg/55")}>{subtitle}</p>
          </div>
        </div>

        <ul className="flex flex-col gap-2">
          {missing.map((requirement) => {
            const Icon = requirement.icon;
            return (
              <li
                key={requirement.kind}
                className={cn(
                  "flex items-start gap-3 border border-warning/20 bg-warning/5 px-3 py-2.5",
                  radius.lg,
                )}
              >
                <div
                  className={cn(
                    "flex h-9 w-9 shrink-0 items-center justify-center border border-warning/30 bg-warning/10 text-warning/80",
                    radius.md,
                  )}
                >
                  <Icon className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-medium text-fg">{requirement.title}</p>
                    <span className="shrink-0 font-mono text-[10px] text-fg/45">
                      {requirement.approxSize}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-fg/50">
                    {requirement.subtitle}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>

        <div className="flex gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className={cn(
              "flex flex-1 items-center justify-center border border-fg/10 bg-fg/5 px-4 py-3 text-sm font-medium text-fg/70",
              radius.md,
              interactive.transition.fast,
              interactive.active.scale,
              "hover:border-fg/20 hover:bg-fg/10",
            )}
          >
            Use Roleplay instead
          </button>
          <button
            type="button"
            onClick={onDownload}
            className={cn(
              "flex flex-1 items-center justify-center gap-2 border border-accent/30 bg-accent/15 px-4 py-3 text-sm font-semibold text-accent",
              radius.md,
              interactive.transition.fast,
              interactive.active.scale,
              "hover:border-accent/45 hover:bg-accent/25",
            )}
          >
            <Download className="h-3.5 w-3.5" />
            Download now
          </button>
        </div>
      </div>
    </BottomMenu>
  );
}
