import { useMemo } from "react";
import { motion } from "framer-motion";
import {
  ArrowLeft,
  BookHeart,
  Brain,
  Heart,
  Link2,
  Loader2,
  Shield,
  Sparkles,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { useParams, useSearchParams } from "react-router-dom";
import {
  WindowControlButtons,
  useDragRegionProps,
  hasCustomWindowControls,
} from "../../components/App/TopNav";
import { cn, components, interactive, radius } from "../../design-tokens";
import { Routes, useNavigationManager } from "../../navigation";
import {
  COMPANION_CATEGORY_LABELS,
  emotionLabel,
  formatPercent,
  formatRelativeTime,
  isCompanionChat,
  topEmotionEntries,
  useCompanionSessionData,
} from "./companionUi";

function PageHeader({
  title,
  subtitle,
  onBack,
  right,
}: {
  title: string;
  subtitle?: string;
  onBack: () => void;
  right?: React.ReactNode;
}) {
  const dragRegionProps = useDragRegionProps();

  return (
    <header
      className={cn(
        "z-20 shrink-0 border-b border-fg/8 pl-3 lg:pl-8",
        hasCustomWindowControls ? "pr-0" : "pr-3 lg:pr-8",
        "bg-surface/95 backdrop-blur-xl",
      )}
      style={{
        paddingTop: "calc(env(safe-area-inset-top) + 12px)",
        paddingBottom: "12px",
      }}
      {...dragRegionProps}
    >
      <div className="flex h-10 items-center justify-between" {...dragRegionProps}>
        <div className="flex min-w-0 items-center gap-2.5">
          <button
            onClick={onBack}
            className="flex shrink-0 items-center justify-center -ml-2 px-[0.6em] py-[0.3em] text-fg/80 transition hover:text-fg"
            aria-label="Back"
          >
            <ArrowLeft size={18} strokeWidth={2.5} />
          </button>
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold text-fg">{title}</p>
            {subtitle ? <p className="truncate text-[11px] text-fg/45">{subtitle}</p> : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {right}
          <WindowControlButtons />
        </div>
      </div>
    </header>
  );
}

function SectionLabel({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-center gap-2">
      <span className="text-[12px] font-semibold uppercase tracking-wider text-fg/50">
        {children}
      </span>
      {right ? <span className="ml-auto text-[10px] text-fg/35">{right}</span> : null}
    </div>
  );
}

function StatTile({
  label,
  value,
  baseline,
  tone = "default",
}: {
  label: string;
  value: number;
  baseline?: number;
  tone?: "default" | "warm" | "warning";
}) {
  const barTone =
    tone === "warm" ? "bg-amber-400" : tone === "warning" ? "bg-rose-400" : "bg-accent";
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const delta = baseline == null ? null : Math.round((value - baseline) * 100);
  const Trend = delta == null ? null : delta >= 0 ? TrendingUp : TrendingDown;

  return (
    <div className="rounded-xl border border-fg/8 bg-fg/2 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-fg/45">
          {label}
        </span>
        {Trend && delta !== 0 ? (
          <span
            className={cn(
              "inline-flex items-center gap-0.5 text-[10px] font-medium tabular-nums",
              delta && delta > 0 ? "text-accent" : "text-rose-400",
            )}
          >
            <Trend size={10} />
            {delta && delta > 0 ? "+" : ""}
            {delta}
          </span>
        ) : null}
      </div>
      <div className="mt-0.5 text-[17px] font-semibold tabular-nums text-fg/90">{pct}%</div>
      <div className="mt-1.5 h-[3px] rounded-full bg-fg/6">
        <div className={cn("h-full rounded-full", barTone)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function EmotionGroup({
  title,
  description,
  entries,
  tone = "default",
}: {
  title: string;
  description: string;
  entries: Array<{ key: string; value: number }>;
  tone?: "default" | "warm" | "warning";
}) {
  const barTone =
    tone === "warm" ? "bg-amber-400" : tone === "warning" ? "bg-rose-400" : "bg-accent";
  return (
    <div className="rounded-xl border border-fg/8 bg-fg/2 p-3">
      <div className="mb-1">
        <div className="text-[12px] font-semibold text-fg/85">{title}</div>
        <div className="text-[10px] text-fg/40">{description}</div>
      </div>
      {entries.length ? (
        <div className="mt-2 space-y-2">
          {entries.map((entry) => {
            const pct = Math.round(Math.max(0, Math.min(1, entry.value)) * 100);
            return (
              <div key={`${title}-${entry.key}`}>
                <div className="mb-0.5 flex items-center justify-between">
                  <span className="text-[11px] text-fg/65">{emotionLabel(entry.key)}</span>
                  <span className="text-[10px] font-medium tabular-nums text-fg/70">{pct}%</span>
                </div>
                <div className="h-[3px] rounded-full bg-fg/6">
                  <div className={cn("h-full rounded-full", barTone)} style={{ width: `${pct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="mt-3 text-[11px] italic text-fg/35">No signal.</p>
      )}
    </div>
  );
}

function SoulCard({
  label,
  value,
  icon: Icon,
}: {
  label: string;
  value?: string | null;
  icon: React.ComponentType<{ size?: number; className?: string }>;
}) {
  const empty = !value?.trim();
  return (
    <div className="rounded-xl border border-fg/8 bg-fg/2 p-3">
      <div className="mb-1.5 flex items-center gap-1.5 text-fg/60">
        <Icon size={12} />
        <span className="text-[10px] font-semibold uppercase tracking-wider">{label}</span>
      </div>
      <p
        className={cn(
          "text-sm leading-relaxed",
          empty ? "italic text-fg/35" : "text-fg/85",
        )}
      >
        {empty ? "Not authored yet." : value}
      </p>
    </div>
  );
}

export function CompanionRelationshipPage() {
  const { characterId } = useParams<{ characterId: string }>();
  const [searchParams] = useSearchParams();
  const sessionId = searchParams.get("sessionId");
  const { go, backOrReplace } = useNavigationManager();
  const { session, character, loading, error, memoryItems } = useCompanionSessionData(
    characterId,
    sessionId,
  );

  const companion = character?.companion ?? null;
  const relationshipState = session?.companionState?.relationshipState;
  const emotionalState = session?.companionState?.emotionalState;
  const activeSignals = session?.companionState?.activeSignals ?? [];

  const feltEntries = useMemo(() => topEmotionEntries(emotionalState?.felt, 5), [emotionalState?.felt]);
  const expressedEntries = useMemo(() => topEmotionEntries(emotionalState?.expressed, 5), [emotionalState?.expressed]);
  const blockedEntries = useMemo(() => topEmotionEntries(emotionalState?.blocked, 5), [emotionalState?.blocked]);
  const momentumEntries = useMemo(() => topEmotionEntries(emotionalState?.momentum, 5), [emotionalState?.momentum]);

  const relationshipTimeline = useMemo(
    () =>
      memoryItems
        .filter((memory) =>
          ["relationship", "milestone", "emotional_snapshot"].includes(memory.category),
        )
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, 18),
    [memoryItems],
  );

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-base text-fg">
        <div className="flex items-center gap-3 text-sm text-fg/60">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading relationship state...
        </div>
      </div>
    );
  }

  if (!characterId || !session || !character || error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-base px-6">
        <div className={cn("w-full max-w-md border border-fg/10 bg-surface p-5 text-center", radius.lg)}>
          <p className="text-base font-semibold text-fg">Relationship state is unavailable</p>
          <p className="mt-2 text-sm text-fg/60">{error || "The chat session could not be loaded."}</p>
          <button
            onClick={() => backOrReplace(characterId ? Routes.chatSession(characterId, sessionId) : Routes.chat)}
            className={cn("mt-4 inline-flex items-center justify-center px-4 py-2 text-sm text-fg", components.button.primary, "border border-fg/10 bg-fg/5")}
          >
            Back to chat
          </button>
        </div>
      </div>
    );
  }

  if (!isCompanionChat(character, session)) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-base px-6">
        <div className={cn("w-full max-w-lg border border-fg/10 bg-surface p-5", radius.lg)}>
          <p className="text-base font-semibold text-fg">This chat is not in companion mode</p>
          <p className="mt-2 text-sm text-fg/60">
            Companion relationship pages only render for chats whose character mode is companion.
          </p>
          <div className="mt-4 flex gap-3">
            <button
              onClick={() => go(Routes.chatMemories(character.id, session.id))}
              className={cn("px-4 py-2 text-sm text-fg", components.button.primary, "border border-fg/10 bg-fg/5")}
            >
              Open regular memories
            </button>
            <button
              onClick={() => backOrReplace(Routes.chatSession(character.id, session.id))}
              className={cn("px-4 py-2 text-sm text-fg/70", components.button.primary, "border border-fg/10 bg-transparent")}
            >
              Back to chat
            </button>
          </div>
        </div>
      </div>
    );
  }

  const interactionCount = relationshipState?.interactionCount ?? 0;
  const stability = relationshipState?.stability ?? 0.5;

  return (
    <div className={cn("flex h-full flex-col bg-base text-fg")}>
      <PageHeader
        title="Relationship state"
        subtitle={session.title || character.name}
        onBack={() => backOrReplace(Routes.chatCompanionMemories(character.id, session.id))}
        right={
          <button
            onClick={() => go(Routes.chatCompanionMemories(character.id, session.id))}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-md border border-fg/10 bg-fg/4 px-2.5 py-1.5 text-[11px] font-medium text-fg/70",
              "hover:border-fg/20 hover:bg-fg/8 hover:text-fg",
              interactive.transition.fast,
            )}
          >
            <Brain size={12} /> Memory
          </button>
        }
      />

      <main className="flex-1 overflow-y-auto px-3 pb-[calc(env(safe-area-inset-bottom)+24px)] pt-4 lg:px-8">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: "easeOut" }}
          className="mx-auto w-full max-w-7xl space-y-7"
        >
          {/* Bond */}
          <section>
            <SectionLabel
              right={
                relationshipState?.lastInteractionAt
                  ? `Last interaction ${formatRelativeTime(relationshipState.lastInteractionAt)}`
                  : undefined
              }
            >
              Bond
            </SectionLabel>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
              <StatTile
                label="Closeness"
                value={relationshipState?.closeness ?? companion?.relationshipDefaults?.closeness ?? 0.2}
                baseline={companion?.relationshipDefaults?.closeness}
              />
              <StatTile
                label="Trust"
                value={relationshipState?.trust ?? companion?.relationshipDefaults?.trust ?? 0.3}
                baseline={companion?.relationshipDefaults?.trust}
              />
              <StatTile
                label="Affection"
                value={relationshipState?.affection ?? companion?.relationshipDefaults?.affection ?? 0.15}
                baseline={companion?.relationshipDefaults?.affection}
                tone="warm"
              />
              <StatTile
                label="Tension"
                value={relationshipState?.tension ?? companion?.relationshipDefaults?.tension ?? 0}
                baseline={companion?.relationshipDefaults?.tension}
                tone="warning"
              />
              <StatTile label="Stability" value={stability} />
              <div className="rounded-xl border border-fg/8 bg-fg/2 px-3 py-2.5">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-fg/45">
                  Interactions
                </div>
                <div className="mt-0.5 text-[17px] font-semibold tabular-nums text-fg/90">
                  {interactionCount.toLocaleString()}
                </div>
                <div className="mt-1.5 text-[10px] text-fg/40">
                  vs. character defaults
                </div>
              </div>
            </div>
          </section>

          {/* Emotional engine */}
          <section>
            <SectionLabel right={`Updated ${formatRelativeTime(emotionalState?.updatedAt)}`}>
              Emotional engine
            </SectionLabel>
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
              <EmotionGroup
                title="Felt"
                description="Internal affect"
                entries={feltEntries}
              />
              <EmotionGroup
                title="Expressed"
                description="Surfaces in replies"
                entries={expressedEntries}
                tone="warm"
              />
              <EmotionGroup
                title="Blocked"
                description="Suppressed by persona"
                entries={blockedEntries}
                tone="warning"
              />
              <EmotionGroup
                title="Momentum"
                description="Trend over recent turns"
                entries={momentumEntries}
              />
            </div>

            {activeSignals.length > 0 && (
              <div className="mt-3 rounded-xl border border-fg/8 bg-fg/2 px-3 py-2.5">
                <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-fg/45">
                  Active drivers
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {activeSignals.map((signal) => (
                    <span
                      key={signal}
                      className="rounded-full border border-fg/10 bg-fg/4 px-2 py-0.5 text-[10px] font-medium text-fg/55"
                    >
                      {signal}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </section>

          {/* Soul */}
          <section>
            <SectionLabel>Soul</SectionLabel>
            <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
              <SoulCard label="Essence" value={companion?.soul?.essence} icon={Sparkles} />
              <SoulCard label="Voice" value={companion?.soul?.voice} icon={BookHeart} />
              <SoulCard label="Relational style" value={companion?.soul?.relationalStyle} icon={Heart} />
              <SoulCard label="Vulnerabilities" value={companion?.soul?.vulnerabilities} icon={Heart} />
              <SoulCard label="Habits" value={companion?.soul?.habits} icon={Link2} />
              <SoulCard label="Boundaries" value={companion?.soul?.boundaries} icon={Shield} />
            </div>
          </section>

          {/* Timeline */}
          <section>
            <SectionLabel right={`${relationshipTimeline.length} events`}>
              Recent timeline
            </SectionLabel>

            {relationshipTimeline.length ? (
              <ol className="relative mx-auto max-w-3xl space-y-2 border-l border-fg/8 pl-4">
                {relationshipTimeline.map((memory) => (
                  <motion.li
                    key={memory.id}
                    initial={{ opacity: 0, x: -4 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.15 }}
                    className="relative"
                  >
                    <span className="absolute -left-[21px] top-3 h-2 w-2 rounded-full border border-fg/15 bg-base" />
                    <div className="rounded-xl border border-fg/6 bg-fg/2 px-3 py-2.5 hover:border-fg/10 hover:bg-fg/3">
                      <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-fg/40">
                        <span className="font-semibold uppercase tracking-wider text-fg/55">
                          {COMPANION_CATEGORY_LABELS[memory.category]}
                        </span>
                        <span className="text-fg/20">·</span>
                        <span>{formatRelativeTime(memory.createdAt)}</span>
                        {memory.sourceRole ? (
                          <>
                            <span className="text-fg/20">·</span>
                            <span>{memory.sourceRole}</span>
                          </>
                        ) : null}
                        {!memory.isActive && (
                          <span className="ml-1 rounded-full border border-warning/25 bg-warning/10 px-1.5 py-0.5 text-[9px] font-medium text-warning">
                            superseded
                          </span>
                        )}
                      </div>
                      <p className="mt-1.5 text-sm leading-relaxed text-fg/90">{memory.text}</p>
                      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-fg/35">
                        <span>Prompt {formatPercent(memory.promptImportance)}</span>
                        <span>Persistence {formatPercent(memory.persistenceImportance)}</span>
                      </div>
                    </div>
                  </motion.li>
                ))}
              </ol>
            ) : (
              <motion.div
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                className="flex flex-col items-center justify-center py-14"
              >
                <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-fg/10 bg-fg/4">
                  <Heart className="h-6 w-6 text-fg/25" />
                </div>
                <h3 className="mb-1 text-sm font-semibold text-fg/85">No timeline yet</h3>
                <p className="max-w-sm text-center text-xs text-fg/45">
                  Relationship, milestone, and emotional snapshot memories will appear here as the
                  companion learns from conversations.
                </p>
              </motion.div>
            )}
          </section>
        </motion.div>
      </main>
    </div>
  );
}
