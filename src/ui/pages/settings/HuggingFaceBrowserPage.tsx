import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  Search,
  Download,
  Heart,
  ArrowDownToLine,
  Loader,
  X,
  ChevronRight,
  Cpu,
  BookOpen,
  Layers,
  TrendingUp,
  Clock,
  ThumbsUp,
  Check,
  AlertTriangle,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

import { cn, typography, interactive } from "../../design-tokens";
import { useI18n } from "../../../core/i18n/context";
import { Routes } from "../../navigation";

// ─── Types ──────────────────────────────────────────────────────────────────

interface HfSearchResult {
  modelId: string;
  author: string;
  likes: number;
  downloads: number;
  tags: string[];
  pipelineTag: string | null;
  lastModified: string | null;
  trendingScore: number | null;
}

interface HfModelFile {
  filename: string;
  size: number;
  quantization: string;
}

interface HfModelInfo {
  modelId: string;
  author: string;
  likes: number;
  downloads: number;
  tags: string[];
  architecture: string | null;
  contextLength: number | null;
  parameterCount: number | null;
  files: HfModelFile[];
}

interface HfDownloadProgress {
  downloaded: number;
  total: number;
  status: string;
  filename: string;
  speedBytesPerSec: number;
}

type SortMode = "trending" | "downloads" | "likes" | "lastModified";

type ViewState =
  | { kind: "search" }
  | { kind: "files"; modelId: string }
  | { kind: "downloading"; modelId: string; filename: string };

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const value = bytes / Math.pow(1024, i);
  return `${value.toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

function extractModelShortName(modelId: string): string {
  const parts = modelId.split("/");
  return parts[parts.length - 1] || modelId;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function HuggingFaceBrowserPage() {
  const { t } = useI18n();
  const navigate = useNavigate();

  // View state machine
  const [view, setView] = useState<ViewState>({ kind: "search" });

  // Search state
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("trending");
  const [results, setResults] = useState<HfSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  // Model detail state
  const [modelInfo, setModelInfo] = useState<HfModelInfo | null>(null);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);

  // Download state
  const [downloadProgress, setDownloadProgress] = useState<HfDownloadProgress | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [downloadedPath, setDownloadedPath] = useState<string | null>(null);

  const searchInputRef = useRef<HTMLInputElement>(null);

  // ─── Debounce search query ──────────────────────────────────────────────

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 350);
    return () => clearTimeout(timer);
  }, [query]);

  // ─── Search models ──────────────────────────────────────────────────────

  const doSearch = useCallback(async () => {
    setSearching(true);
    setSearchError(null);
    try {
      const sortField =
        sortMode === "trending"
          ? "trendingScore"
          : sortMode === "downloads"
            ? "downloads"
            : sortMode === "likes"
              ? "likes"
              : "lastModified";

      const data = await invoke<HfSearchResult[]>("hf_search_models", {
        query: debouncedQuery,
        limit: 30,
        sort: sortField,
      });
      setResults(data);
    } catch (err: any) {
      setSearchError(err?.message || String(err));
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, [debouncedQuery, sortMode]);

  useEffect(() => {
    if (view.kind === "search") {
      doSearch();
    }
  }, [debouncedQuery, sortMode, view.kind, doSearch]);

  // ─── Fetch model files ────────────────────────────────────────────────

  const openModelFiles = useCallback(async (modelId: string) => {
    setView({ kind: "files", modelId });
    setModelInfo(null);
    setLoadingFiles(true);
    setFilesError(null);
    try {
      const info = await invoke<HfModelInfo>("hf_get_model_files", { modelId });
      setModelInfo(info);
    } catch (err: any) {
      setFilesError(err?.message || String(err));
    } finally {
      setLoadingFiles(false);
    }
  }, []);

  // ─── Download ─────────────────────────────────────────────────────────

  const startDownload = useCallback(async (modelId: string, filename: string) => {
    setView({ kind: "downloading", modelId, filename });
    setDownloadProgress(null);
    setDownloadError(null);
    setDownloadedPath(null);

    try {
      const path = await invoke<string>("hf_download_model", { modelId, filename });
      setDownloadedPath(path);
    } catch (err: any) {
      const msg = err?.message || String(err);
      if (msg.includes("cancelled")) {
        setDownloadError("cancelled");
      } else {
        setDownloadError(msg);
      }
    }
  }, []);

  const cancelDownload = useCallback(async () => {
    try {
      await invoke("hf_cancel_download");
    } catch {
      // ignore
    }
  }, []);

  // ─── Listen for download progress events ──────────────────────────────

  useEffect(() => {
    let unlisten: (() => void) | null = null;

    listen<HfDownloadProgress>("hf_download_progress", (event) => {
      setDownloadProgress(event.payload);
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // ─── Navigate to model creation after download ────────────────────────

  const goToCreateModel = useCallback(() => {
    if (!downloadedPath || view.kind !== "downloading") return;
    const { modelId, filename } = view;
    const displayName = extractModelShortName(modelId).replace(/-GGUF$/i, "");
    const params = new URLSearchParams();
    params.set("hfModelPath", downloadedPath);
    params.set("hfModelName", filename);
    params.set("hfDisplayName", displayName);
    navigate(`${Routes.settingsModelsNew}?${params.toString()}`);
  }, [downloadedPath, view, navigate]);

  // ─── Render ───────────────────────────────────────────────────────────

  return (
    <div className="flex h-full flex-col text-fg">
      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <AnimatePresence mode="wait">
          {view.kind === "search" && (
            <motion.div
              key="search"
              initial={{ opacity: 0, x: -10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -10 }}
              transition={{ duration: 0.15 }}
              className="flex flex-col"
            >
              {/* Search bar */}
              <div className="sticky top-0 z-10 border-b border-fg/5 bg-surface px-4 py-3 space-y-3">
                <div className="relative">
                  <Search
                    size={16}
                    className="absolute left-3 top-1/2 -translate-y-1/2 text-fg/40"
                  />
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t("hfBrowser.searchPlaceholder")}
                    className={cn(
                      "w-full rounded-xl border border-fg/10 bg-fg/5 py-2.5 pl-9 pr-9 text-sm text-fg placeholder-fg/40",
                      "focus:border-fg/25 focus:outline-none transition",
                    )}
                  />
                  {query && (
                    <button
                      onClick={() => setQuery("")}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-fg/40 hover:text-fg/70"
                    >
                      <X size={14} />
                    </button>
                  )}
                </div>

                {/* Sort pills */}
                <div className="flex gap-2 overflow-x-auto pb-0.5 no-scrollbar">
                  {(
                    [
                      { key: "trending", icon: TrendingUp, label: t("hfBrowser.sortTrending") },
                      {
                        key: "downloads",
                        icon: ArrowDownToLine,
                        label: t("hfBrowser.sortDownloads"),
                      },
                      { key: "likes", icon: ThumbsUp, label: t("hfBrowser.sortLikes") },
                      { key: "lastModified", icon: Clock, label: t("hfBrowser.sortRecent") },
                    ] as const
                  ).map(({ key, icon: Icon, label }) => (
                    <button
                      key={key}
                      onClick={() => setSortMode(key)}
                      className={cn(
                        "flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition",
                        sortMode === key
                          ? "border-accent/40 bg-accent/15 text-accent"
                          : "border-fg/10 bg-fg/5 text-fg/60 hover:border-fg/20",
                      )}
                    >
                      <Icon size={12} />
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              {/* Results */}
              <div className="px-4 py-3 space-y-2">
                {searching && (
                  <div className="flex items-center justify-center gap-2 py-16 text-fg/50">
                    <Loader size={18} className="animate-spin" />
                    <span className="text-sm">{t("hfBrowser.searching")}</span>
                  </div>
                )}

                {searchError && (
                  <div className="flex flex-col items-center gap-2 py-16 text-center">
                    <AlertTriangle size={24} className="text-danger/70" />
                    <p className="text-sm text-fg/60">{searchError}</p>
                  </div>
                )}

                {!searching && !searchError && results.length === 0 && (
                  <div className="flex flex-col items-center gap-2 py-16 text-center">
                    <Search size={32} className="text-fg/20" />
                    <p className="text-sm font-medium text-fg/60">{t("hfBrowser.noResults")}</p>
                    <p className="text-xs text-fg/40">{t("hfBrowser.noResultsHint")}</p>
                  </div>
                )}

                {!searching &&
                  results.map((model) => (
                    <button
                      key={model.modelId}
                      onClick={() => openModelFiles(model.modelId)}
                      className={cn(
                        "group w-full rounded-xl border border-fg/10 bg-fg/[0.03] px-4 py-3 text-left transition",
                        "hover:border-fg/20 hover:bg-fg/[0.06] active:scale-[0.995]",
                      )}
                    >
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span
                              className={cn(
                                "truncate text-sm font-semibold text-fg",
                                typography.body.lineHeight,
                              )}
                            >
                              {extractModelShortName(model.modelId)}
                            </span>
                          </div>
                          <p className="mt-0.5 truncate text-xs text-fg/45">{model.author}</p>
                          <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-fg/50">
                            <span className="flex items-center gap-1">
                              <Heart size={11} className="text-pink-400/70" />
                              {formatNumber(model.likes)}
                            </span>
                            <span className="flex items-center gap-1">
                              <ArrowDownToLine size={11} className="text-blue-400/70" />
                              {formatNumber(model.downloads)}
                            </span>
                            {model.pipelineTag && (
                              <span className="rounded-md border border-fg/10 bg-fg/5 px-1.5 py-0.5 text-[10px]">
                                {model.pipelineTag}
                              </span>
                            )}
                          </div>
                        </div>
                        <ChevronRight
                          size={16}
                          className="mt-1 shrink-0 text-fg/25 group-hover:text-fg/50 transition"
                        />
                      </div>
                    </button>
                  ))}
              </div>
            </motion.div>
          )}

          {view.kind === "files" && (
            <motion.div
              key="files"
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 10 }}
              transition={{ duration: 0.15 }}
              className="flex flex-col"
            >
              {loadingFiles && (
                <div className="flex items-center justify-center gap-2 py-20 text-fg/50">
                  <Loader size={18} className="animate-spin" />
                  <span className="text-sm">Loading model info...</span>
                </div>
              )}

              {filesError && (
                <div className="flex flex-col items-center gap-3 px-4 py-20 text-center">
                  <AlertTriangle size={24} className="text-danger/70" />
                  <p className="text-sm text-fg/60">{filesError}</p>
                  <button
                    onClick={() => setView({ kind: "search" })}
                    className="text-xs text-accent hover:underline"
                  >
                    {t("hfBrowser.backToSearch")}
                  </button>
                </div>
              )}

              {modelInfo && (
                <div className="space-y-4 px-4 py-4">
                  {/* Model header */}
                  <div>
                    <h2 className={cn(typography.h2.size, typography.h2.weight)}>
                      {extractModelShortName(modelInfo.modelId)}
                    </h2>
                    <p className="mt-0.5 text-xs text-fg/45">{modelInfo.author}</p>

                    {/* Stats row */}
                    <div className="mt-3 flex flex-wrap gap-3">
                      {modelInfo.architecture && (
                        <div className="flex items-center gap-1.5 rounded-lg border border-fg/10 bg-fg/5 px-2.5 py-1.5 text-xs text-fg/70">
                          <Cpu size={12} className="text-accent/70" />
                          {modelInfo.architecture}
                        </div>
                      )}
                      {modelInfo.contextLength && (
                        <div className="flex items-center gap-1.5 rounded-lg border border-fg/10 bg-fg/5 px-2.5 py-1.5 text-xs text-fg/70">
                          <BookOpen size={12} className="text-info/70" />
                          {formatNumber(modelInfo.contextLength)} ctx
                        </div>
                      )}
                      {modelInfo.parameterCount && (
                        <div className="flex items-center gap-1.5 rounded-lg border border-fg/10 bg-fg/5 px-2.5 py-1.5 text-xs text-fg/70">
                          <Layers size={12} className="text-secondary/70" />
                          {formatBytes(modelInfo.parameterCount)} params
                        </div>
                      )}
                    </div>

                    <div className="mt-2 flex items-center gap-3 text-xs text-fg/45">
                      <span className="flex items-center gap-1">
                        <Heart size={11} className="text-pink-400/70" />
                        {formatNumber(modelInfo.likes)} {t("hfBrowser.likes")}
                      </span>
                      <span className="flex items-center gap-1">
                        <ArrowDownToLine size={11} className="text-blue-400/70" />
                        {formatNumber(modelInfo.downloads)} {t("hfBrowser.downloads")}
                      </span>
                    </div>
                  </div>

                  {/* Files list */}
                  <div>
                    <h3
                      className={cn(
                        "mb-2 text-[10px] font-semibold uppercase tracking-[0.2em] text-fg/40",
                      )}
                    >
                      {t("hfBrowser.files")} ({modelInfo.files.length})
                    </h3>

                    {modelInfo.files.length === 0 && (
                      <p className="py-8 text-center text-sm text-fg/40">
                        {t("hfBrowser.noFiles")}
                      </p>
                    )}

                    <div className="space-y-2">
                      {modelInfo.files.map((file) => (
                        <div
                          key={file.filename}
                          className={cn("rounded-xl border border-fg/10 bg-fg/[0.03] px-4 py-3")}
                        >
                          <div className="flex items-start gap-3">
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium text-fg">
                                {file.filename}
                              </p>
                              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                                <span className="rounded-md border border-accent/20 bg-accent/10 px-1.5 py-0.5 text-[10px] font-semibold text-accent/80">
                                  {file.quantization}
                                </span>
                                <span className="text-[11px] text-fg/45">
                                  {formatBytes(file.size)}
                                </span>
                              </div>
                            </div>
                            <button
                              onClick={() => startDownload(modelInfo.modelId, file.filename)}
                              className={cn(
                                "flex shrink-0 items-center gap-1.5 rounded-lg border border-accent/30 bg-accent/15 px-3 py-2 text-xs font-semibold text-accent",
                                interactive.transition.default,
                                "hover:bg-accent/25 active:scale-95",
                              )}
                            >
                              <Download size={13} />
                              {t("hfBrowser.download")}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {view.kind === "downloading" && (
            <motion.div
              key="downloading"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              transition={{ duration: 0.2 }}
              className="flex flex-1 flex-col items-center justify-center px-6 py-12"
            >
              <DownloadView
                progress={downloadProgress}
                error={downloadError}
                downloadedPath={downloadedPath}
                filename={view.filename}
                modelId={view.modelId}
                onCancel={cancelDownload}
                onCreateModel={goToCreateModel}
                onBackToFiles={() => setView({ kind: "files", modelId: view.modelId })}
                t={t}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ─── Download sub-view ──────────────────────────────────────────────────────

function DownloadView({
  progress,
  error,
  downloadedPath,
  filename,
  modelId: _modelId,
  onCancel,
  onCreateModel,
  onBackToFiles,
  t,
}: {
  progress: HfDownloadProgress | null;
  error: string | null;
  downloadedPath: string | null;
  filename: string;
  modelId: string;
  onCancel: () => void;
  onCreateModel: () => void;
  onBackToFiles: () => void;
  t: (key: any, params?: any) => string;
}) {
  const isComplete = downloadedPath !== null;
  const isCancelled = error === "cancelled";
  const isError = error !== null && !isCancelled;
  const isDownloading = !isComplete && !isError && !isCancelled && progress?.status !== "complete";

  const pct =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : 0;

  return (
    <div className="flex w-full max-w-sm flex-col items-center text-center space-y-6">
      {/* Icon */}
      <div
        className={cn(
          "flex h-20 w-20 items-center justify-center rounded-3xl border",
          isComplete
            ? "border-emerald-400/30 bg-emerald-500/15"
            : isError
              ? "border-danger/30 bg-danger/15"
              : isCancelled
                ? "border-fg/20 bg-fg/10"
                : "border-accent/30 bg-accent/15",
        )}
      >
        {isComplete && <Check className="h-10 w-10 text-emerald-300" />}
        {isError && <AlertTriangle className="h-10 w-10 text-danger/80" />}
        {isCancelled && <X className="h-10 w-10 text-fg/50" />}
        {isDownloading && <Download className="h-10 w-10 text-accent/80 animate-pulse" />}
      </div>

      {/* Title */}
      <div>
        <h2 className="text-lg font-bold text-fg">
          {isComplete
            ? t("hfBrowser.downloadComplete")
            : isError
              ? t("hfBrowser.downloadFailed")
              : isCancelled
                ? t("hfBrowser.downloadCancelled")
                : t("hfBrowser.downloading")}
        </h2>
        <p className="mt-1 text-xs text-fg/50 break-all">{filename}</p>
      </div>

      {/* Progress bar */}
      {isDownloading && progress && (
        <div className="w-full space-y-2">
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-fg/10">
            <motion.div
              className="h-full rounded-full bg-accent"
              initial={{ width: 0 }}
              animate={{ width: `${pct}%` }}
              transition={{ duration: 0.3, ease: "easeOut" }}
            />
          </div>
          <div className="flex items-center justify-between text-[11px] text-fg/50">
            <span>
              {formatBytes(progress.downloaded)} / {formatBytes(progress.total)}
            </span>
            <span className="tabular-nums">{pct}%</span>
          </div>
          {progress.speedBytesPerSec > 0 && (
            <p className="text-[11px] text-fg/40">{formatSpeed(progress.speedBytesPerSec)}</p>
          )}
        </div>
      )}

      {/* Error message */}
      {isError && (
        <p className="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2 text-xs text-danger/80">
          {error}
        </p>
      )}

      {/* Actions */}
      <div className="flex w-full flex-col gap-2 pt-2">
        {isDownloading && (
          <button
            onClick={onCancel}
            className={cn(
              "w-full rounded-xl border border-danger/30 bg-danger/15 py-3 text-sm font-semibold text-danger/90",
              interactive.transition.default,
              "hover:bg-danger/25 active:scale-[0.98]",
            )}
          >
            {t("hfBrowser.cancelDownload")}
          </button>
        )}

        {isComplete && (
          <>
            <button
              onClick={onCreateModel}
              className={cn(
                "w-full flex items-center justify-center gap-2 rounded-xl border border-emerald-400/40 bg-emerald-500/20 py-3 text-sm font-bold text-emerald-100",
                interactive.transition.default,
                "hover:bg-emerald-500/30 active:scale-[0.98]",
              )}
            >
              <Cpu size={16} />
              {t("hfBrowser.createModel")}
            </button>
            <button
              onClick={onBackToFiles}
              className={cn(
                "w-full rounded-xl border border-fg/10 bg-fg/5 py-3 text-sm text-fg/60",
                interactive.transition.default,
                "hover:bg-fg/10 active:scale-[0.98]",
              )}
            >
              {t("hfBrowser.backToFiles")}
            </button>
          </>
        )}

        {(isError || isCancelled) && (
          <button
            onClick={onBackToFiles}
            className={cn(
              "w-full rounded-xl border border-fg/10 bg-fg/5 py-3 text-sm text-fg/60",
              interactive.transition.default,
              "hover:bg-fg/10 active:scale-[0.98]",
            )}
          >
            {t("hfBrowser.backToFiles")}
          </button>
        )}
      </div>
    </div>
  );
}
