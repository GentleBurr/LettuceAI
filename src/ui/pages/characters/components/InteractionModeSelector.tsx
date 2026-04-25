import { BookOpen, MessageCircleHeart } from "lucide-react";
import type { CharacterMode } from "../../../../core/storage/schemas";
import { cn, interactive, radius, typography } from "../../../design-tokens";

interface InteractionModeSelectorProps {
  mode: CharacterMode;
  onChange: (mode: CharacterMode) => void;
  disabled?: boolean;
}

const modes: Array<{
  id: CharacterMode;
  title: string;
  subtitle: string;
  icon: typeof BookOpen;
}> = [
  {
    id: "roleplay",
    title: "Roleplay",
    subtitle: "Scene-driven chats, narrative framing, and starting scenarios.",
    icon: BookOpen,
  },
  {
    id: "companion",
    title: "Companion",
    subtitle: "Relationship-driven chats with emotional state and companion memory.",
    icon: MessageCircleHeart,
  },
];

export function InteractionModeSelector({
  mode,
  onChange,
  disabled = false,
}: InteractionModeSelectorProps) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div>
          <div
            className={cn(
              typography.label.size,
              typography.label.weight,
              typography.label.tracking,
              "uppercase text-fg/70",
            )}
          >
            Interaction Mode
          </div>
          <p className={cn(typography.bodySmall.size, "mt-1 text-fg/45")}>
            Choose whether this character behaves like an RP character or a persistent companion.
          </p>
        </div>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        {modes.map((option) => {
          const Icon = option.icon;
          const selected = mode === option.id;
          return (
            <button
              key={option.id}
              type="button"
              disabled={disabled}
              onClick={() => onChange(option.id)}
              aria-pressed={selected}
              className={cn(
                "group relative overflow-hidden rounded-xl border px-4 py-3.5 text-left",
                interactive.transition.default,
                interactive.active.scale,
                disabled && "cursor-not-allowed opacity-60",
                selected
                  ? "border-accent/40 bg-accent/10 shadow-[0_0_0_1px_rgba(16,185,129,0.25),0_8px_24px_-12px_rgba(16,185,129,0.35)]"
                  : "border-fg/10 bg-fg/[0.03] hover:border-fg/20 hover:bg-fg/5",
              )}
            >
              {selected && (
                <div
                  className="pointer-events-none absolute inset-0 opacity-80"
                  style={{
                    background:
                      "radial-gradient(circle at 12% 0%, rgba(16,185,129,0.18) 0%, transparent 55%)",
                  }}
                />
              )}

              {selected && (
                <span className="pointer-events-none absolute right-3 top-3 rounded-md border border-accent/35 bg-accent/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase leading-none tracking-[0.2em] text-accent/90">
                  Active
                </span>
              )}

              <div className="relative flex items-start gap-3">
                <div
                  className={cn(
                    "flex h-9 w-9 shrink-0 items-center justify-center border",
                    radius.lg,
                    interactive.transition.default,
                    selected
                      ? "border-accent/40 bg-accent/15 text-accent shadow-lg shadow-accent/15"
                      : "border-fg/10 bg-fg/5 text-fg/45 group-hover:border-fg/20 group-hover:text-fg/70",
                  )}
                >
                  <Icon className="h-4 w-4" />
                </div>
                <div className="min-w-0 pr-12">
                  <p
                    className={cn(
                      "text-sm font-semibold transition-colors",
                      selected ? "text-fg" : "text-fg/85 group-hover:text-fg",
                    )}
                  >
                    {option.title}
                  </p>
                  <p
                    className={cn(
                      "mt-1 text-xs leading-relaxed transition-colors",
                      selected ? "text-fg/60" : "text-fg/45",
                    )}
                  >
                    {option.subtitle}
                  </p>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
