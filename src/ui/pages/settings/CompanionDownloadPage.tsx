import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Download, Heart, Tag, Waypoints, X } from "lucide-react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { storageBridge } from "../../../core/storage/files";
import { useI18n } from "../../../core/i18n/context";
import {
  ModelDownloadProgress,
  type ModelDownloadPhase,
} from "./components/ModelDownloadProgress";
import { useModelDownload } from "./hooks/useModelDownload";

type Kind = "emotion" | "ner" | "router";

const META: Record<
  Kind,
  { title: string; subtitle: string; approxSize: string; icon: typeof Heart }
> = {
  emotion: {
    title: "Emotion classifier",
    subtitle: "Reads turns and updates the companion's felt, expressed, and blocked emotion vectors.",
    approxSize: "~120 MB",
    icon: Heart,
  },
  ner: {
    title: "Entity extractor (NER)",
    subtitle: "Identifies people, places, and objects so memories can be canonicalized and linked.",
    approxSize: "~140 MB",
    icon: Tag,
  },
  router: {
    title: "Memory router",
    subtitle:
      "Decides whether new turns should be stored as relationship, milestone, episodic, or other memory categories.",
    approxSize: "~70 MB",
    icon: Waypoints,
  },
};

function isKind(value: string | null): value is Kind {
  return value === "emotion" || value === "ner" || value === "router";
}

export function CompanionDownloadPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const kindParam = searchParams.get("kind");
  const returnTo = searchParams.get("returnTo") ?? "/settings/advanced/companions";
  const [completed, setCompleted] = useState(false);
  const [countdown, setCountdown] = useState(3);

  const kind: Kind | null = isKind(kindParam) ? kindParam : null;
  const meta = useMemo(() => (kind ? META[kind] : null), [kind]);

  const download = useModelDownload({
    onComplete: () => {
      setCompleted(true);
    },
  });

  useEffect(() => {
    if (!completed) return;
    setCountdown(3);
    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(timer);
          navigate(returnTo, { replace: true });
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [completed, navigate, returnTo]);

  if (!kind || !meta) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="rounded-xl border border-danger/20 bg-danger/10 p-4 text-sm text-danger/80">
          Unknown companion model. Provide ?kind=emotion|ner|router.
        </div>
      </div>
    );
  }

  const startDownload = async () => {
    try {
      await download.start(() => storageBridge.startCompanionDownload(kind));
    } catch {
      // error captured by hook
    }
  };

  const handleCancel = async () => {
    try {
      await download.cancel();
      navigate(returnTo);
    } catch {
      // error captured by hook
    }
  };

  const Icon = meta.icon;
  const phase: ModelDownloadPhase = completed
    ? "passed"
    : download.progress.status === "failed"
      ? "failed"
      : download.isDownloading || download.progress.status === "downloading"
        ? "downloading"
        : "idle";

  const headerTitle = completed
    ? `${meta.title} installed`
    : download.isDownloading
      ? `Downloading ${meta.title}`
      : `Install ${meta.title}`;

  const headerDescription = completed
    ? `Redirecting in ${countdown} seconds...`
    : download.isDownloading
      ? "Fetching model files…"
      : meta.subtitle;

  const statusText = completed
    ? "Installed and ready"
    : download.progress.status === "downloading"
      ? `Downloading ${meta.title.toLowerCase()}…`
      : download.progress.status === "failed"
        ? "Download failed"
        : download.progress.status === "cancelled"
          ? "Download cancelled"
          : "Ready to install";

  const showStartButton = !download.isDownloading && !completed && download.progress.status !== "failed";

  return (
    <div className="flex min-h-screen flex-col">
      <main className="flex-1 px-4 pb-24 pt-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          className="mx-auto w-full max-w-2xl space-y-6"
        >
          <div className="text-center">
            <h1 className="text-2xl font-bold text-fg">{headerTitle}</h1>
            <p className="mt-2 text-sm text-fg/60">{headerDescription}</p>
          </div>

          {showStartButton ? (
            <div className="rounded-xl border border-fg/10 bg-fg/5 p-6">
              <div className="text-center mb-6">
                <div className="flex h-16 w-16 mx-auto items-center justify-center rounded-full border border-info/20 bg-info/10">
                  <Icon className="h-8 w-8 text-info" />
                </div>
                <p className="mt-4 text-sm text-fg/70">{meta.subtitle}</p>
              </div>

              <button
                onClick={startDownload}
                className="w-full mt-2 py-3 px-4 rounded-xl bg-info hover:bg-info/80 text-fg font-medium transition-colors flex items-center justify-center gap-2"
              >
                <Download className="h-5 w-5" />
                Download {meta.title} ({meta.approxSize})
              </button>

              <button
                onClick={() => navigate(returnTo)}
                className="w-full py-2 mt-2 text-sm text-fg/50 hover:text-fg/70 transition-colors"
              >
                {t("common.buttons.cancel")}
              </button>
            </div>
          ) : (
            <ModelDownloadProgress
              progress={download.progress}
              phase={phase}
              statusText={statusText}
            />
          )}

          {download.error && (
            <div className="rounded-lg border border-danger/20 bg-danger/10 p-3">
              <p className="text-sm text-danger/80">{download.error}</p>
            </div>
          )}

          {download.isDownloading && (
            <button
              onClick={handleCancel}
              className="flex w-full items-center justify-center gap-2 rounded-xl border border-danger/20 bg-danger/10 px-6 py-3 text-sm font-medium text-danger/80 transition hover:border-danger/30 hover:bg-danger/15"
            >
              <X className="h-4 w-4" />
              {t("common.buttons.cancel")}
            </button>
          )}

          {!download.isDownloading && download.progress.status === "failed" && (
            <div className="space-y-3">
              <button
                onClick={() => {
                  download.setError(null);
                  startDownload();
                }}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-info px-6 py-3 text-sm font-medium text-fg transition hover:bg-info/80"
              >
                <Download className="h-4 w-4" />
                Retry Download
              </button>
              <button
                onClick={() => navigate(returnTo)}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-fg/10 bg-fg/5 px-6 py-3 text-sm font-medium text-fg/60 transition hover:bg-fg/10"
              >
                Go Back
              </button>
            </div>
          )}
        </motion.div>
      </main>
    </div>
  );
}
