import { motion } from "framer-motion";
import { Sparkles, ArrowRight, X } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useI18n } from "../../core/i18n/context";

interface EmbeddingUpgradePromptProps {
  onDismiss: () => void;
  returnTo?: string;
  currentVersion: "v1" | "v2";
}

/**
 * A prompt shown to users with an older embedding model installed,
 * encouraging them to upgrade to v3.
 */
export function EmbeddingUpgradePrompt({
  onDismiss,
  returnTo,
  currentVersion,
}: EmbeddingUpgradePromptProps) {
  const { t } = useI18n();
  const navigate = useNavigate();

  const handleUpgrade = () => {
    const params = new URLSearchParams();
    params.set("upgrade", "true");
    if (returnTo) {
      params.set("returnTo", returnTo);
    }
    navigate(`/settings/embedding-download?${params.toString()}`);
  };

  const title = t("components.embeddingUpgrade.title");
  const body =
    currentVersion === "v1"
      ? t("components.embeddingUpgrade.v1Message")
      : t("components.embeddingUpgrade.v2Message");

  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 20 }}
      className="rounded-2xl border border-amber-500/30 bg-black/95 backdrop-blur-xl p-4 shadow-2xl shadow-amber-500/10"
    >
      <div className="flex items-start gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-amber-500/20">
          <Sparkles className="h-5 w-5 text-amber-400" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3 className="font-semibold text-amber-200 text-base">{title}</h3>
              <p className="mt-1.5 text-sm text-amber-200/70 leading-relaxed">{body}</p>
            </div>
            <button
              onClick={onDismiss}
              className="shrink-0 p-1.5 text-amber-400/50 hover:text-amber-400 transition-colors rounded-lg hover:bg-amber-400/10"
              aria-label="Dismiss"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-4 flex gap-3">
            <button
              onClick={handleUpgrade}
              className="flex items-center gap-1.5 rounded-xl bg-amber-500 px-4 py-2 text-sm font-semibold text-black transition-all hover:bg-amber-400 shadow-lg shadow-amber-500/20"
            >
              {t("components.embeddingUpgrade.button")}
              <ArrowRight className="h-4 w-4" />
            </button>
            <button
              onClick={onDismiss}
              className="rounded-xl px-4 py-2 text-sm text-amber-200/60 hover:text-amber-200 transition-colors hover:bg-white/5"
            >
              {t("common.buttons.later")}
            </button>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
