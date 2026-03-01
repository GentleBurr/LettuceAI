import { useState, useEffect, useCallback, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import {
  Search,
  Download,
  Heart,
  ArrowDownToLine,
  Loader,
  X,
  Cpu,
  BookOpen,
  Layers,
  TrendingUp,
  Clock,
  ThumbsUp,
  AlertTriangle,
  FileText,
  ExternalLink,
  Settings2,
  Monitor,
  ChevronDown,
  Info,
} from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

import { cn, typography, interactive } from "../../design-tokens";
import { useI18n } from "../../../core/i18n/context";
import { HfReadmeRenderer } from "./components/HfReadmeRenderer";
import { InlineDownloadCards } from "./components/DownloadQueueBar";
import { useDownloadQueue } from "../../../core/downloads/DownloadQueueContext";
import { BottomMenu, MenuLabel, MenuDivider } from "../../components/BottomMenu";

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

interface RunabilityScore {
  filename: string;
  score: number;
  label: "excellent" | "good" | "marginal" | "poor" | "unrunnable";
  fitsInRam: boolean;
  fitsInVram: boolean;
}

interface FileRecommendation {
  filename: string;
  size: number;
  quantization: string;
  quantQuality: number;
  maxContextF16: number;
  maxContextQ80: number;
  maxContextQ40: number;
  /** Max context for 100% GPU offload (Q8_0 KV). 0 if model doesn't fit. */
  optimalGpuCtx: number;
  /** Max context for total RAM+VRAM before swapping (Q8_0 KV). */
  optimalRamCtx: number;
}

interface BestRecommendation {
  filename: string;
  contextLength: number;
  kvType: string;
  score: number;
  viable: boolean;
}

interface ModelArchInfo {
  architecture: string | null;
  blockCount: number | null;
  embeddingLength: number | null;
  headCount: number | null;
  headCountKv: number | null;
  contextLength: number | null;
  feedForwardLength: number | null;
  fileType: number | null;
  slidingWindow: number | null;
  kvLoraRank: number | null;
  keyLength: number | null;
  valueLength: number | null;
  incompleteParse: boolean;
}

interface RecommendationData {
  availableRam: number;
  availableVram: number;
  unifiedMemory: boolean;
  totalAvailable: number;
  kvBasePerToken: number | null;
  kvContextCap: number | null;
  modelMaxContext: number;
  arch: ModelArchInfo | null;
  files: FileRecommendation[];
  best: BestRecommendation | null;
}

const KV_BPV: Record<string, number> = {
  f32: 4.0,
  f16: 2.0,
  q8_0: 1.0,
  q5_1: 0.6875,
  q5_0: 0.625,
  q4_1: 0.5625,
  q4_0: 0.5,
  iq4_nl: 0.5,
};

/** Compute max context for a given file size + KV BPV dynamically */
function maxContextForBpv(
  fileSize: number,
  kvBasePerToken: number | null,
  bpv: number,
  totalAvailable: number,
  modelMaxCtx: number,
): number {
  if (!kvBasePerToken || kvBasePerToken <= 0) return modelMaxCtx;
  const overhead = computeOverhead(fileSize);
  const remaining = Math.max(totalAvailable - fileSize - overhead, 0);
  const bytesPerToken = kvBasePerToken * bpv;
  if (bytesPerToken <= 0) return modelMaxCtx;
  const maxCtx = Math.floor(remaining / bytesPerToken);
  return Math.min(Math.max(maxCtx, 0), modelMaxCtx);
}

/** Compute buffer overhead: max(modelSize × 5%, 200MB) */
function computeOverhead(modelSize: number): number {
  return Math.max(modelSize * 0.05, 200_000_000);
}

function calcScore(
  modelSize: number,
  quantQuality: number,
  kvCacheBytes: number,
  totalAvailable: number,
  availableVram: number,
): { score: number; label: string; fitsVram: boolean; gpuMode: string } {
  const overhead = computeOverhead(modelSize);
  const totalNeeded = modelSize + kvCacheBytes + overhead;

  // Memory fitness (25%)
  let memoryScore: number;
  if (totalAvailable === 0) memoryScore = 50;
  else if (totalNeeded > totalAvailable) memoryScore = 0;
  else {
    const r = totalAvailable / totalNeeded;
    memoryScore = r < 1.2 ? 20 : r < 1.5 ? 50 : r < 2.0 ? 70 : r < 3.0 ? 85 : 100;
  }

  // GPU acceleration (35%)
  const vramBudget = availableVram * 0.9;
  let gpuScore: number;
  let fitsVram: boolean;
  let gpuMode: string;
  if (availableVram > 0) {
    if (totalNeeded <= vramBudget) {
      // Everything fits in VRAM
      gpuScore = 100; fitsVram = true; gpuMode = "full";
    } else if (modelSize === 0) {
      gpuScore = 10; fitsVram = false; gpuMode = "cpu";
    } else if (modelSize <= vramBudget) {
      // Model weights fit, KV/compute spills to RAM
      const remaining = vramBudget - modelSize;
      const spill = kvCacheBytes + overhead;
      const fitRatio = spill > 0 ? Math.min(remaining / spill, 1.0) : 1.0;
      gpuScore = 70 + fitRatio * 25; // 70-95
      fitsVram = true;
      gpuMode = fitRatio >= 0.8 ? "nearFull" : fitRatio >= 0.4 ? "kvSpill" : "kvHeavySpill";
    } else {
      // Model doesn't fit — partial layer offload
      const offloadRatio = Math.min(vramBudget / modelSize, 1.0);
      gpuScore = 10 + offloadRatio * 60; // 10-70
      fitsVram = false;
      gpuMode = offloadRatio >= 0.75 ? "mostLayers"
        : offloadRatio >= 0.5 ? "halfLayers"
        : offloadRatio >= 0.2 ? "fewLayers"
        : "cpu";
    }
  } else {
    gpuScore = 0; fitsVram = false; gpuMode = "cpu";
  }

  // KV headroom (15%)
  let kvScore: number;
  const headroom = Math.max(totalAvailable - modelSize - overhead, 0);
  if (kvCacheBytes === 0) kvScore = 50;
  else if (headroom === 0) kvScore = 0;
  else if (headroom >= kvCacheBytes) {
    const r = headroom / kvCacheBytes;
    kvScore = r >= 2.0 ? 100 : 50 + 50 * (r - 1.0);
  } else {
    kvScore = 50 * (headroom / kvCacheBytes);
  }

  let raw = memoryScore * 0.25 + gpuScore * 0.35 + kvScore * 0.15 + quantQuality * 0.25;
  if (memoryScore === 0) raw = Math.min(raw, 10);
  const score = Math.min(Math.round(raw), 100);
  const label = score >= 80 ? "excellent" : score >= 60 ? "good" : score >= 40 ? "marginal" : score >= 20 ? "poor" : "unrunnable";
  return { score, label, fitsVram, gpuMode };
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

type SortMode = "trending" | "downloads" | "likes" | "lastModified";

type ViewState = { kind: "search" } | { kind: "model"; modelId: string };

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

function formatTimeAgo(isoDate: string): string {
  const now = Date.now();
  const then = new Date(isoDate).getTime();
  if (isNaN(then)) return isoDate;
  const diffMs = now - then;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(months / 12);
  return `${years}y ago`;
}

/** Try to extract a human-readable param size from tags or model name.
 *  Checks tags first (e.g. "7b"), then falls back to parsing the model name
 *  (e.g. "Qwen3.5-35B-A3B-GGUF" → "35B"). */
function extractParamSize(tags: string[], modelId: string): string | null {
  for (const tag of tags) {
    const lower = tag.toLowerCase();
    const match = lower.match(/^(\d+(?:\.\d+)?)(b|m|k|t)$/);
    if (match) {
      return `${match[1]}${match[2].toUpperCase()}`;
    }
  }
  const name = modelId.split("/").pop() || modelId;
  const nameMatch = name.match(/[-_](\d+(?:\.\d+)?)[Bb][-_]/);
  if (nameMatch) {
    return `${nameMatch[1]}B`;
  }
  const endMatch = name.match(/[-_](\d+(?:\.\d+)?)[Bb](?:-|$)/);
  if (endMatch) {
    return `${endMatch[1]}B`;
  }
  return null;
}

/** Generate a deterministic color from a string for avatar fallback */
function authorColor(name: string): string {
  const colors = [
    "bg-emerald-500/30",
    "bg-blue-500/30",
    "bg-violet-500/30",
    "bg-amber-500/30",
    "bg-rose-500/30",
    "bg-cyan-500/30",
    "bg-pink-500/30",
    "bg-teal-500/30",
  ];
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0;
  }
  return colors[Math.abs(hash) % colors.length];
}

function formatParams(count: number): string {
  const fmt = (n: number) => (n % 1 === 0 ? n.toFixed(0) : n.toFixed(1));
  if (count >= 1_000_000_000_000) return `${fmt(count / 1_000_000_000_000)}T`;
  if (count >= 1_000_000_000) return `${fmt(count / 1_000_000_000)}B`;
  if (count >= 1_000_000) return `${fmt(count / 1_000_000)}M`;
  if (count >= 1_000) return `${fmt(count / 1_000)}K`;
  return count.toString();
}

function extractModelShortName(modelId: string): string {
  const parts = modelId.split("/");
  return parts[parts.length - 1] || modelId;
}

/** Extract a model ID from a HuggingFace URL, or return null if not a HF URL. */
function parseHfUrl(input: string): string | null {
  const trimmed = input.trim();
  try {
    const url = new URL(trimmed);
    if (url.hostname !== "huggingface.co" && url.hostname !== "www.huggingface.co") return null;
    const segments = url.pathname.split("/").filter(Boolean);
    if (segments.length >= 2) {
      return `${segments[0]}/${segments[1]}`;
    }
  } catch {
    const hfMatch = trimmed.match(/^(?:www\.)?huggingface\.co\/([^/]+\/[^/\s]+)/i);
    if (hfMatch) return hfMatch[1];
  }
  return null;
}

export function HuggingFaceBrowserPage() {
  const { t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const { queueDownload, hasItems: hasDownloads } = useDownloadQueue();

  const [avatars, setAvatars] = useState<Record<string, string>>({});

  const view: ViewState = (() => {
    const modelParam = searchParams.get("model");
    if (modelParam) return { kind: "model", modelId: modelParam };
    return { kind: "search" };
  })();

  const setView = useCallback(
    (v: ViewState) => {
      if (v.kind === "search") {
        setSearchParams({}, { replace: true });
      } else if (v.kind === "model") {
        setSearchParams({ model: v.modelId }, { replace: false });
      }
    },
    [setSearchParams],
  );

  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("trending");
  const [results, setResults] = useState<HfSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [hasSearched, setHasSearched] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);

  const PAGE_SIZE = 30;

  const [modelInfo, setModelInfo] = useState<HfModelInfo | null>(null);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);

  const [readme, setReadme] = useState<string | null>(null);
  const [readmeLoading, setReadmeLoading] = useState(false);
  const [runabilityScores, setRunabilityScores] = useState<Record<string, RunabilityScore>>({});

  // Recommendation panel state
  const [recData, setRecData] = useState<RecommendationData | null>(null);
  const [recLoading, setRecLoading] = useState(false);
  const [recOpen, setRecOpen] = useState<string | null>(null); // filename of open panel
  const [recFile, setRecFile] = useState(""); // selected file in dropdown
  const [recContext, setRecContext] = useState(4096);
  const [recKvType, setRecKvType] = useState("f16");
  const [detailSheetOpen, setDetailSheetOpen] = useState(false);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const filesPanelRef = useRef<HTMLDivElement>(null);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (view.kind !== "model" || !filesPanelRef.current) return;

    let scrollable: HTMLElement | null = filesPanelRef.current.parentElement;
    while (scrollable) {
      const style = getComputedStyle(scrollable);
      if (
        (style.overflowY === "auto" || style.overflowY === "scroll") &&
        scrollable.scrollHeight > scrollable.clientHeight
      ) {
        break;
      }
      scrollable = scrollable.parentElement;
    }
    if (!scrollable) return;

    const updatePanel = () => {
      const panel = filesPanelRef.current;
      if (!panel) return;
      const scrollTop = scrollable!.scrollTop;
      panel.style.transform = `translateY(${scrollTop}px)`;
      const panelRect = panel.getBoundingClientRect();
      const availableHeight = window.innerHeight - panelRect.top - 24;
      panel.style.maxHeight = `${Math.max(availableHeight, 200)}px`;
    };

    const handleScroll = () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(updatePanel);
    };

    scrollable.addEventListener("scroll", handleScroll, { passive: true });
    window.addEventListener("resize", handleScroll, { passive: true });
    filesPanelRef.current.style.transform = "translateY(0px)";
    updatePanel();
    return () => {
      scrollable!.removeEventListener("scroll", handleScroll);
      window.removeEventListener("resize", handleScroll);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [view.kind, modelInfo]);

  useEffect(() => {
    const modelId = parseHfUrl(query);
    if (modelId) {
      setDebouncedQuery(modelId);
      return;
    }
    const timer = setTimeout(() => setDebouncedQuery(query), 350);
    return () => clearTimeout(timer);
  }, [query]);

  const sortField = useCallback(
    (mode: SortMode) =>
      mode === "trending"
        ? "trendingScore"
        : mode === "downloads"
          ? "downloads"
          : mode === "likes"
            ? "likes"
            : "lastModified",
    [],
  );

  const isDirectLookup = parseHfUrl(query) !== null;

  const doSearch = useCallback(async () => {
    setSearching(true);
    setSearchError(null);
    setHasMore(true);
    try {
      const data = await invoke<HfSearchResult[]>("hf_search_models", {
        query: debouncedQuery,
        limit: isDirectLookup ? 5 : PAGE_SIZE,
        sort: sortField(sortMode),
        offset: 0,
      });
      if (isDirectLookup) {
        const exact = data.filter((d) => d.modelId.toLowerCase() === debouncedQuery.toLowerCase());
        setResults(exact.length > 0 ? exact : data.slice(0, 1));
        setHasMore(false);
      } else {
        setResults(data);
        if (data.length < PAGE_SIZE) setHasMore(false);
      }
    } catch (err: any) {
      setSearchError(err?.message || String(err));
      setResults([]);
      setHasMore(false);
    } finally {
      setSearching(false);
      setHasSearched(true);
    }
  }, [debouncedQuery, sortMode, sortField, isDirectLookup]);

  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const data = await invoke<HfSearchResult[]>("hf_search_models", {
        query: debouncedQuery,
        limit: PAGE_SIZE,
        sort: sortField(sortMode),
        offset: results.length,
      });
      if (data.length < PAGE_SIZE) setHasMore(false);
      if (data.length > 0) {
        setResults((prev) => [...prev, ...data]);
      }
    } catch { } finally {
      setLoadingMore(false);
    }
  }, [loadingMore, hasMore, debouncedQuery, sortMode, sortField, results.length]);

  useEffect(() => {
    if (view.kind === "search") {
      doSearch();
    }
  }, [debouncedQuery, sortMode, view.kind, doSearch]);

  useEffect(() => {
    if (results.length === 0) return;
    const uniqueAuthors = [...new Set(results.map((r) => r.author))];
    const missing = uniqueAuthors.filter((a) => !(a in avatars));
    if (missing.length === 0) return;

    let cancelled = false;
    invoke<Record<string, string>>("hf_get_avatars", { authors: missing })
      .then((fetched) => {
        if (cancelled) return;
        setAvatars((prev) => ({ ...prev, ...fetched }));
      })
      .catch(() => {});

    return () => {
      cancelled = true;
    };
  }, [results]); // eslint-disable-line react-hooks/exhaustive-deps

  const openModel = useCallback(
    async (modelId: string) => {
      setView({ kind: "model", modelId });
      setModelInfo(null);
      setLoadingFiles(true);
      setFilesError(null);
      setReadme(null);
      setReadmeLoading(true);
      setRunabilityScores({});
      setRecData(null);
      setRecOpen(null);

      const filesPromise = invoke<HfModelInfo>("hf_get_model_files", { modelId })
        .then((info) => {
          setModelInfo(info);
          // Fetch runability scores in background
          if (info.files.length > 0) {
            invoke<RunabilityScore[]>("hf_compute_runability", {
              modelId: info.modelId,
              files: info.files.map((f) => ({
                filename: f.filename,
                size: f.size,
                quantization: f.quantization,
              })),
            })
              .then((scores) => {
                const map: Record<string, RunabilityScore> = {};
                for (const s of scores) map[s.filename] = s;
                setRunabilityScores(map);
              })
              .catch(() => {});
          }
        })
        .catch((err: any) => {
          setFilesError(err?.message || String(err));
        })
        .finally(() => {
          setLoadingFiles(false);
        });

      const readmePromise = invoke<string>("hf_fetch_readme", { modelId })
        .then((md) => {
          setReadme(md);
        })
        .catch(() => {
          setReadme(null);
        })
        .finally(() => {
          setReadmeLoading(false);
        });

      await Promise.allSettled([filesPromise, readmePromise]);
    },
    [setView],
  );

  return (
    <div className="flex h-full flex-col text-fg">
      <div className="flex-1">
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

              {/* Content area */}
              <div className="px-4 py-3 space-y-2">
                {/* Inline download cards */}
                {hasDownloads && (
                  <InlineDownloadCards
                    showDivider={results.length > 0 || searching}
                    dividerLabel={t("hfBrowser.sortTrending")}
                  />
                )}

                {/* Loading state  */}
                {searching && !hasSearched && (
                  <div className="grid grid-cols-2 gap-2">
                    {Array.from({ length: 12 }).map((_, i) => (
                      <div
                        key={i}
                        className="rounded-xl border border-fg/5 bg-fg/[0.02] px-3 py-2.5 animate-pulse"
                      >
                        <div className="flex items-center gap-2">
                          <div className="h-5 w-5 rounded-full bg-fg/8" />
                          <div className="h-3 flex-1 rounded bg-fg/8" />
                        </div>
                        <div className="mt-2 flex gap-2">
                          <div className="h-2.5 w-20 rounded bg-fg/5" />
                          <div className="h-2.5 w-10 rounded bg-fg/5" />
                        </div>
                        <div className="mt-1.5 flex gap-2">
                          <div className="h-2.5 w-10 rounded bg-fg/5" />
                          <div className="h-2.5 w-8 rounded bg-fg/5" />
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Searching spinner */}
                {searching && hasSearched && (
                  <div className="flex items-center justify-center gap-2 py-12 text-fg/50">
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

                {!searching && !searchError && hasSearched && results.length === 0 && (
                  <div className="flex flex-col items-center gap-2 py-16 text-center">
                    <Search size={32} className="text-fg/20" />
                    <p className="text-sm font-medium text-fg/60">{t("hfBrowser.noResults")}</p>
                    <p className="text-xs text-fg/40">{t("hfBrowser.noResultsHint")}</p>
                  </div>
                )}

                {!searching && results.length > 0 && (
                  <div className="grid grid-cols-2 gap-2">
                    {results.map((model) => {
                      const paramSize = extractParamSize(model.tags, model.modelId);
                      const avatarUrl = avatars[model.author];
                      return (
                        <button
                          key={model.modelId}
                          onClick={() => openModel(model.modelId)}
                          className={cn(
                            "group rounded-xl border border-fg/10 bg-fg/[0.03] px-3 py-2.5 text-left transition",
                            "hover:border-fg/20 hover:bg-fg/[0.06] active:scale-[0.98]",
                          )}
                        >
                          {/* Model name with author avatar */}
                          <div className="flex items-center gap-2 min-w-0">
                            {avatarUrl ? (
                              <img
                                src={avatarUrl}
                                alt={model.author}
                                className="h-5 w-5 shrink-0 rounded-full object-cover"
                                loading="lazy"
                              />
                            ) : (
                              <div
                                className={cn(
                                  "flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[12px] font-bold text-fg/70",
                                  authorColor(model.author),
                                )}
                              >
                                {model.author.charAt(0).toUpperCase()}
                              </div>
                            )}
                            <span className="truncate text-[13px] font-semibold text-fg">
                              {model.modelId}
                            </span>
                          </div>

                          {/* Meta: pipeline tag · param size · updated */}
                          <div className="mt-1.5 flex items-center gap-1.5 text-[11px] text-fg/50 overflow-hidden">
                            {model.pipelineTag && (
                              <>
                                <Cpu size={10} className="shrink-0 text-fg/40" />
                                <span className="truncate">{model.pipelineTag}</span>
                              </>
                            )}
                            {paramSize && (
                              <>
                                <span className="text-fg/20 shrink-0">·</span>
                                <Layers size={10} className="shrink-0 text-fg/40" />
                                <span className="shrink-0">{paramSize}</span>
                              </>
                            )}
                            {model.lastModified && (
                              <>
                                <span className="text-fg/20 shrink-0">·</span>
                                <span className="truncate">
                                  {formatTimeAgo(model.lastModified)}
                                </span>
                              </>
                            )}
                          </div>

                          {/* Stats: downloads · likes */}
                          <div className="mt-1.5 flex items-center gap-3 text-[11px] text-fg/45">
                            <span className="flex items-center gap-1">
                              <ArrowDownToLine size={10} className="text-fg/35" />
                              {formatNumber(model.downloads)}
                            </span>
                            <span className="flex items-center gap-1">
                              <Heart size={10} className="text-fg/35" />
                              {formatNumber(model.likes)}
                            </span>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Load more button (hidden for direct URL lookups) */}
                {!searching && hasSearched && results.length > 0 && hasMore && !isDirectLookup && (
                  <div className="flex justify-center pt-2 pb-4">
                    <button
                      onClick={loadMore}
                      disabled={loadingMore}
                      className={cn(
                        "flex items-center gap-2 rounded-xl border border-fg/10 bg-fg/5 px-6 py-2.5 text-sm font-medium text-fg/60 transition",
                        "hover:border-fg/20 hover:bg-fg/10 hover:text-fg/80 active:scale-[0.98]",
                        loadingMore && "pointer-events-none opacity-60",
                      )}
                    >
                      {loadingMore ? (
                        <>
                          <Loader size={14} className="animate-spin" />
                          Loading...
                        </>
                      ) : (
                        "Load more"
                      )}
                    </button>
                  </div>
                )}

                {/* End of results indicator (not for direct lookups) */}
                {!searching && hasSearched && results.length > 0 && !hasMore && !isDirectLookup && (
                  <p className="py-4 text-center text-[11px] text-fg/25">No more results</p>
                )}
              </div>
            </motion.div>
          )}

          {view.kind === "model" && (
            <motion.div
              key="model"
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: 10 }}
              transition={{ duration: 0.15 }}
              className="flex flex-col"
            >
              {/* Loading state */}
              {loadingFiles && !modelInfo && (
                <div className="flex items-center justify-center gap-2 py-20 text-fg/50">
                  <Loader size={18} className="animate-spin" />
                  <span className="text-sm">Loading model info...</span>
                </div>
              )}

              {/* Error state */}
              {filesError && !modelInfo && (
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

              {/* Main content */}
              {modelInfo && (
                <div className="flex items-stretch">
                  <div className="flex-1 min-w-0">
                    {/* Model header card */}
                    <div className="border-b border-fg/5 px-4 py-4">
                      <div className="flex items-center gap-2">
                        <h1
                          className={cn(typography.h1.size, typography.h1.weight, "text-fg flex-1")}
                        >
                          {extractModelShortName(modelInfo.modelId)}
                        </h1>
                        <a
                          href={`https://huggingface.co/${modelInfo.modelId}`}
                          target="_blank"
                          rel="noreferrer"
                          className="flex shrink-0 items-center gap-1 text-[11px] text-accent/70 hover:text-accent transition"
                        >
                          <ExternalLink size={12} />
                          HuggingFace
                        </a>
                      </div>
                      <p className="mt-0.5 text-xs text-fg/45">{modelInfo.author}</p>

                      {/* Stats row */}
                      <div className="mt-3 flex flex-wrap gap-2">
                        {modelInfo.architecture && (
                          <div className="flex items-center gap-1.5 rounded-lg border border-fg/10 bg-fg/5 px-2.5 py-1.5 text-xs text-fg/70">
                            <Cpu size={12} className="text-accent/70" />
                            {modelInfo.architecture}
                          </div>
                        )}
                        {modelInfo.contextLength != null && (
                          <div className="flex items-center gap-1.5 rounded-lg border border-fg/10 bg-fg/5 px-2.5 py-1.5 text-xs text-fg/70">
                            <BookOpen size={12} className="text-info/70" />
                            {formatNumber(modelInfo.contextLength)} ctx
                          </div>
                        )}
                        {modelInfo.parameterCount != null && (
                          <div className="flex items-center gap-1.5 rounded-lg border border-fg/10 bg-fg/5 px-2.5 py-1.5 text-xs text-fg/70">
                            <Layers size={12} className="text-secondary/70" />
                            {formatParams(modelInfo.parameterCount)} params
                          </div>
                        )}
                      </div>

                      <div className="mt-2 flex items-center gap-4 text-xs text-fg/45">
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

                    {/* Download cards on model detail page */}
                    {hasDownloads && (
                      <div className="border-b border-fg/5 px-4 py-3">
                        <InlineDownloadCards />
                      </div>
                    )}

                    {/* README content */}
                    <div className="px-4 py-4 pb-24">
                      {readmeLoading && (
                        <div className="flex items-center justify-center gap-2 py-12 text-fg/40">
                          <Loader size={16} className="animate-spin" />
                          <span className="text-xs">Loading README...</span>
                        </div>
                      )}

                      {!readmeLoading && readme && <HfReadmeRenderer content={readme} />}

                      {!readmeLoading && !readme && (
                        <div className="flex flex-col items-center gap-2 py-12 text-center text-fg/30">
                          <FileText size={32} />
                          <p className="text-sm">No README available</p>
                        </div>
                      )}
                    </div>
                  </div>

                  {modelInfo.files.filter((f) => f.size > 0).length > 0 && (
                    <div className="w-84 shrink-0 border-l border-fg/10 bg-surface/50 relative">
                      <div
                        ref={filesPanelRef}
                        className="flex flex-col overflow-hidden will-change-transform rounded-b-xl"
                      >
                        {/* Files header */}
                        <div className="flex items-center gap-2 border-b border-fg/10 px-4 py-3">
                          <Download size={14} className="text-fg/40" />
                          <h3 className="text-[10px] font-semibold uppercase tracking-[0.2em] text-fg/40">
                            {t("hfBrowser.files")} ({modelInfo.files.filter((f) => f.size > 0).length})
                          </h3>
                        </div>

                        {/* Settings advisor */}
                        {(() => {
                          return (
                            <div className="border-b border-fg/10 px-3 py-2.5">
                              <button
                                onClick={async () => {
                                  if (recOpen) {
                                    setRecOpen(null);
                                    return;
                                  }
                                  setRecOpen("__advisor__");
                                  if (!recData) {
                                    setRecLoading(true);
                                    try {
                                      const data = await invoke<RecommendationData>(
                                        "hf_get_recommendation_data",
                                        {
                                          modelId: modelInfo.modelId,
                                          files: modelInfo.files
                                            .filter((f) => f.size > 0)
                                            .map((f) => ({
                                              filename: f.filename,
                                              size: f.size,
                                              quantization: f.quantization,
                                            })),
                                        },
                                      );
                                      setRecData(data);
                                      setRecFile(data.best?.filename || modelInfo.files[0]?.filename || "");
                                      setRecContext(data.best?.contextLength || 4096);
                                      setRecKvType(data.best?.kvType || "q8_0");
                                    } catch { /* silently fail */ } finally {
                                      setRecLoading(false);
                                    }
                                  }
                                }}
                                className={cn(
                                  "flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-[11px] font-medium transition",
                                  recOpen
                                    ? "border-amber-400/30 bg-amber-400/10 text-amber-500"
                                    : "border-fg/10 bg-fg/5 text-fg/50 hover:border-fg/20 hover:text-fg/70",
                                )}
                              >
                                {recLoading ? (
                                  <Loader size={12} className="animate-spin shrink-0" />
                                ) : (
                                  <Settings2 size={12} className="shrink-0" />
                                )}
                                <span className="flex-1 text-left">{t("hfBrowser.recommendedSettings")}</span>
                                <ChevronDown
                                  size={11}
                                  className={cn("transition-transform shrink-0", recOpen && "rotate-180")}
                                />
                              </button>

                              {recOpen && recData && (() => {
                                const selFile = recData.files.find((f) => f.filename === recFile)
                                  || recData.files[0];
                                if (!selFile) return null;

                                const totalAvail = recData.totalAvailable;
                                const bpvSel = KV_BPV[recKvType] || 2;
                                const maxCtx = Math.max(maxContextForBpv(selFile.size, recData.kvBasePerToken, bpvSel, totalAvail, recData.modelMaxContext), 1024);
                                const clampedCtx = Math.min(Math.max(recContext, 1024), maxCtx);

                                const effectiveKvCtx = recData.kvContextCap
                                  ? Math.min(clampedCtx, recData.kvContextCap)
                                  : clampedCtx;
                                const kvBytes = recData.kvBasePerToken
                                  ? recData.kvBasePerToken * bpvSel * effectiveKvCtx
                                  : 0;
                                const { score, label, gpuMode } = calcScore(
                                  selFile.size,
                                  selFile.quantQuality,
                                  kvBytes,
                                  totalAvail,
                                  recData.availableVram,
                                );

                                const scoreColor =
                                  label === "excellent" ? "text-emerald-500" :
                                  label === "good" ? "text-blue-500" :
                                  label === "marginal" ? "text-amber-500" :
                                  label === "poor" ? "text-orange-500" :
                                  "text-red-500";

                                const scoreBg =
                                  label === "excellent" ? "bg-emerald-400/15" :
                                  label === "good" ? "bg-blue-400/15" :
                                  label === "marginal" ? "bg-amber-400/15" :
                                  label === "poor" ? "bg-orange-400/15" :
                                  "bg-red-400/15";

                                const gpuLabel = ({
                                  full: t("hfBrowser.gpuFull"),
                                  nearFull: t("hfBrowser.gpuNearFull"),
                                  kvSpill: t("hfBrowser.gpuKvSpill"),
                                  kvHeavySpill: t("hfBrowser.gpuKvHeavySpill"),
                                  mostLayers: t("hfBrowser.gpuMostLayers"),
                                  halfLayers: t("hfBrowser.gpuHalfLayers"),
                                  fewLayers: t("hfBrowser.gpuFewLayers"),
                                  cpu: t("hfBrowser.gpuCpu"),
                                }[gpuMode]) || t("hfBrowser.gpuCpu");

                                const upgradeSuggestion = (() => {
                                  if (selFile.quantQuality >= 90) return null; // already top tier
                                  const bpvVal = KV_BPV[recKvType] || 2;
                                  let best: { file: FileRecommendation; score: number } | null = null;
                                  for (const f of recData.files) {
                                    if (f.quantQuality <= selFile.quantQuality) continue;
                                    if (f.filename === selFile.filename) continue;
                                    const fMaxCtx = Math.max(maxContextForBpv(f.size, recData.kvBasePerToken, bpvVal, totalAvail, recData.modelMaxContext), 1024);
                                    if (fMaxCtx < 1024) continue;
                                    const fCtx = Math.min(clampedCtx, fMaxCtx);
                                    const fEffKvCtx = recData.kvContextCap ? Math.min(fCtx, recData.kvContextCap) : fCtx;
                                    const fKv = recData.kvBasePerToken
                                      ? recData.kvBasePerToken * bpvVal * fEffKvCtx : 0;
                                    const { score: fScore } = calcScore(
                                      f.size, f.quantQuality, fKv, totalAvail, recData.availableVram,
                                    );
                                    if (fScore < 70) continue;
                                    if (!best || f.quantQuality > best.file.quantQuality ||
                                        (f.quantQuality === best.file.quantQuality && fScore > best.score)) {
                                      best = { file: f, score: fScore };
                                    }
                                  }
                                  return best;
                                })();

                                return (
                                  <div className="mt-2 space-y-2.5">
                                    {/* Score hero */}
                                    <div className={cn("flex items-center justify-between rounded-lg px-3 py-2", scoreBg)}>
                                      <div className="flex items-center gap-2">
                                        <span className={cn("text-xl font-bold", scoreColor)}>{score}</span>
                                        <div className="leading-tight">
                                          <span className={cn("text-[13px] font-semibold", scoreColor)}>{
                                            ({
                                              excellent: t("hfBrowser.runabilityExcellent"),
                                              good: t("hfBrowser.runabilityGood"),
                                              marginal: t("hfBrowser.runabilityMarginal"),
                                              poor: t("hfBrowser.runabilityPoor"),
                                              unrunnable: t("hfBrowser.runabilityUnrunnable"),
                                            } as Record<string, string>)[label] || label
                                          }</span>
                                          <p className="text-[12px] text-fg/40 flex items-center gap-1">
                                            <Monitor size={9} />
                                            {gpuLabel}
                                          </p>
                                        </div>
                                      </div>
                                    </div>


                                    {/* Upgrade suggestion */}
                                    {upgradeSuggestion && (
                                      <button
                                        onClick={() => {
                                          setRecFile(upgradeSuggestion.file.filename);
                                          const mx = Math.max(maxContextForBpv(upgradeSuggestion.file.size, recData.kvBasePerToken, bpvSel, totalAvail, recData.modelMaxContext), 1024);
                                          setRecContext(Math.min(recContext, mx));
                                        }}
                                        className="flex w-full items-start gap-2 rounded-lg border border-emerald-400/20 bg-emerald-400/5 px-2.5 py-2 text-left transition hover:bg-emerald-400/10 active:scale-[0.98]"
                                      >
                                        <TrendingUp size={11} className="text-emerald-400 shrink-0 mt-0.5" />
                                        <div className="flex-1 min-w-0">
                                          <p className="text-[12px] leading-snug text-emerald-400/90">
                                            {t("hfBrowser.upgradeSuggestion", {
                                              quant: upgradeSuggestion.file.quantization,
                                              size: formatBytes(upgradeSuggestion.file.size),
                                              score: upgradeSuggestion.score.toString(),
                                            })}
                                          </p>
                                        </div>
                                      </button>
                                    )}

                                    {/* Quantization */}
                                    <div>
                                      <label className="text-[9px] font-semibold uppercase tracking-wider text-fg/40">
                                        {t("hfBrowser.quantization")}
                                      </label>
                                      <select
                                        value={recFile}
                                        onChange={(e) => {
                                          setRecFile(e.target.value);
                                          const f = recData.files.find((x) => x.filename === e.target.value);
                                          if (f) {
                                            const mx = Math.max(maxContextForBpv(f.size, recData.kvBasePerToken, bpvSel, totalAvail, recData.modelMaxContext), 1024);
                                            const optimal = f.optimalGpuCtx > 0 ? f.optimalGpuCtx
                                              : f.optimalRamCtx > 0 ? f.optimalRamCtx : 8192;
                                            setRecContext(Math.min(optimal, mx));
                                          }
                                        }}
                                        className="mt-1 w-full rounded-md border border-fg/10 bg-fg/5 px-2 py-1.5 text-[11px] text-fg focus:border-fg/25 focus:outline-none"
                                      >
                                        {recData.files.map((f) => (
                                          <option key={f.filename} value={f.filename}>
                                            {f.quantization} — {formatBytes(f.size)}
                                          </option>
                                        ))}
                                      </select>
                                    </div>

                                    {/* Context length */}
                                    {(() => {
                                      const modelMax = recData.modelMaxContext;
                                      // Max context for 100% GPU offload (model+KV+compute all in VRAM)
                                      const fullGpuCtx = (() => {
                                        if (recData.availableVram <= 0 || !recData.kvBasePerToken) return 0;
                                        const vBudget = recData.availableVram * 0.9;
                                        const oh = computeOverhead(selFile.size);
                                        if (selFile.size + oh >= vBudget) return 0;
                                        const vramForKv = vBudget - selFile.size - oh;
                                        const bpvVal = KV_BPV[recKvType] || 2;
                                        const rawCtx = Math.floor(vramForKv / (recData.kvBasePerToken * bpvVal));
                                        if (recData.kvContextCap && rawCtx >= recData.kvContextCap) return modelMax;
                                        return rawCtx >= 512 ? Math.min(rawCtx, modelMax) : 0;
                                      })();
                                      // Max context before RAM runs out (dynamic for current KV type)
                                      const ramCtx = (() => {
                                        if (!recData.kvBasePerToken) return 0;
                                        const oh = computeOverhead(selFile.size);
                                        const remaining = Math.max(totalAvail - selFile.size - oh, 0);
                                        const bpvVal = KV_BPV[recKvType] || 2;
                                        const rawCtx = Math.floor(remaining / (recData.kvBasePerToken * bpvVal));
                                        if (recData.kvContextCap && rawCtx >= recData.kvContextCap) return modelMax;
                                        return rawCtx >= 512 ? Math.min(rawCtx, modelMax) : 0;
                                      })();

                                      return (
                                      <div>
                                      <div className="flex items-center justify-between">
                                        <label className="text-[9px] font-semibold uppercase tracking-wider text-fg/40">
                                          {t("hfBrowser.contextLength")}
                                        </label>
                                        <span className="text-[12px] font-mono text-fg/60">{clampedCtx.toLocaleString()}</span>
                                      </div>
                                      <div className="relative mt-1">
                                        <input
                                          type="range"
                                          min={1024}
                                          max={maxCtx}
                                          step={256}
                                          value={clampedCtx}
                                          onChange={(e) => setRecContext(Number(e.target.value))}
                                          className="w-full accent-accent h-1.5"
                                        />
                                        {/* Optimal context tick marks below slider */}
                                        {maxCtx > 1024 && (() => {
                                          const pct = (v: number) => ((v - 1024) / (maxCtx - 1024)) * 100;
                                          return (
                                            <>
                                              {fullGpuCtx > 1024 && fullGpuCtx < maxCtx && (
                                                <div
                                                  className="absolute bottom-0 w-0.5 bg-emerald-400 rounded-full pointer-events-none"
                                                  style={{ left: `${pct(fullGpuCtx)}%`, height: 6, transform: "translateY(100%)" }}
                                                />
                                              )}
                                              {ramCtx > 1024 && ramCtx < maxCtx && ramCtx !== fullGpuCtx && (
                                                <div
                                                  className="absolute bottom-0 w-0.5 bg-amber-400 rounded-full pointer-events-none"
                                                  style={{ left: `${pct(ramCtx)}%`, height: 6, transform: "translateY(100%)" }}
                                                />
                                              )}
                                            </>
                                          );
                                        })()}
                                      </div>
                                      <div className="flex justify-between text-[9px] text-fg/30">
                                        <span>1,024</span>
                                        <span>{maxCtx.toLocaleString()}</span>
                                      </div>
                                      {/* Clickable context presets */}
                                      {(fullGpuCtx > 0 || ramCtx > 0) && (
                                        <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1.5">
                                          {fullGpuCtx > 0 && fullGpuCtx < maxCtx && (
                                            <button
                                              type="button"
                                              onClick={() => setRecContext(Math.min(fullGpuCtx, maxCtx))}
                                              className="flex items-center gap-1.5 text-[12px] font-medium text-emerald-400/80 hover:text-emerald-300 transition-colors"
                                            >
                                              <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 shadow-[0_0_4px_rgba(52,211,153,0.4)]" />
                                              {t("hfBrowser.optimalGpuCtxShort", { ctx: fullGpuCtx.toLocaleString() })}
                                            </button>
                                          )}
                                          {ramCtx > 0 && ramCtx !== fullGpuCtx && (
                                            <button
                                              type="button"
                                              onClick={() => setRecContext(Math.min(ramCtx, maxCtx))}
                                              className="flex items-center gap-1.5 text-[12px] font-medium text-amber-400/80 hover:text-amber-300 transition-colors"
                                            >
                                              <span className="inline-block w-2 h-2 rounded-full bg-amber-400 shadow-[0_0_4px_rgba(251,191,36,0.4)]" />
                                              {t("hfBrowser.optimalRamCtxShort", { ctx: ramCtx.toLocaleString() })}
                                            </button>
                                          )}
                                        </div>
                                      )}
                                      {/* Warning: exceeding GPU-optimal context */}
                                      {fullGpuCtx > 0 && fullGpuCtx < maxCtx && clampedCtx > fullGpuCtx && (
                                        <div className="flex items-start gap-2 mt-1.5 rounded-lg border border-amber-400/20 bg-amber-400/5 px-2.5 py-2">
                                          <AlertTriangle size={13} className="text-amber-400 shrink-0 mt-0.5" />
                                          <p className="text-[11px] leading-snug text-amber-400/80">
                                            {t("hfBrowser.ctxExceedsGpu", { ctx: fullGpuCtx.toLocaleString() })}
                                          </p>
                                        </div>
                                      )}
                                      {/* State B: Model exceeds VRAM entirely */}
                                      {fullGpuCtx === 0 && ramCtx > 0 && (
                                        <div className="flex items-start gap-2 mt-1.5 rounded-lg border border-blue-400/20 bg-blue-400/5 px-2.5 py-2">
                                          <Info size={13} className="text-blue-400 shrink-0 mt-0.5" />
                                          <p className="text-[11px] leading-snug text-blue-300/80">
                                            {t("hfBrowser.modelExceedsVram")}
                                          </p>
                                        </div>
                                      )}
                                    </div>
                                      );
                                    })()}

                                    {/* KV Cache type */}
                                    <div>
                                      <label className="text-[9px] font-semibold uppercase tracking-wider text-fg/40">
                                        {t("hfBrowser.kvCacheType")}
                                      </label>
                                      <select
                                        value={recKvType}
                                        onChange={(e) => {
                                          setRecKvType(e.target.value);
                                          const bpv = KV_BPV[e.target.value] || 2;
                                          const mx = Math.max(maxContextForBpv(selFile.size, recData.kvBasePerToken, bpv, totalAvail, recData.modelMaxContext), 1024);
                                          setRecContext((prev) => Math.min(prev, mx));
                                        }}
                                        className="mt-1 w-full rounded-md border border-fg/10 bg-fg/5 px-2 py-1.5 text-[11px] text-fg focus:border-fg/25 focus:outline-none"
                                      >
                                        <option value="f32">F32 (maximum quality)</option>
                                        <option value="f16">F16 (high quality)</option>
                                        <option value="q8_0">Q8_0 (balanced)</option>
                                        <option value="q5_1">Q5_1 (good savings)</option>
                                        <option value="q5_0">Q5_0 (good savings)</option>
                                        <option value="q4_1">Q4_1 (memory saver)</option>
                                        <option value="q4_0">Q4_0 (memory saver)</option>
                                        <option value="iq4_nl">IQ4_NL (aggressive)</option>
                                      </select>
                                    </div>

                                    {/* Warning */}
                                    {score < 60 && (
                                      <div className="flex items-start gap-2 rounded-lg border border-red-400/20 bg-red-400/10 px-2.5 py-2">
                                        <AlertTriangle size={12} className="text-red-400 shrink-0 mt-0.5" />
                                        <p className="text-[12px] leading-snug text-red-400/90">
                                          {t("hfBrowser.notRecommended")}
                                        </p>
                                      </div>
                                    )}

                                    {/* Download recommended */}
                                    {score >= 60 && (
                                      <button
                                        onClick={() => queueDownload(modelInfo.modelId, recFile)}
                                        className={cn(
                                          "flex w-full items-center justify-center gap-1.5 rounded-lg border border-emerald-400/30 bg-emerald-400/15 py-1.5 text-[11px] font-semibold text-emerald-500",
                                          interactive.transition.default,
                                          "hover:bg-emerald-400/25 active:scale-[0.97]",
                                        )}
                                      >
                                        <Download size={12} />
                                        {t("hfBrowser.download")} {selFile.quantization}
                                      </button>
                                    )}

                                    {/* More details button */}
                                    <button
                                      onClick={() => setDetailSheetOpen(true)}
                                      className="flex w-full items-center justify-center gap-1 py-1 text-[12px] text-fg/40 hover:text-fg/60 transition-colors"
                                    >
                                      <Info size={10} />
                                      {t("hfBrowser.moreDetails")}
                                    </button>
                                  </div>
                                );
                              })()}
                            </div>
                          );
                        })()}

                        {/* Scrollable files list */}
                        <div className="flex-1 overflow-y-auto px-3 py-3 pb-6 space-y-2">
                          {modelInfo.files.filter((f) => f.size > 0).map((file) => {
                            const rs = runabilityScores[file.filename];
                            return (
                            <div
                              key={file.filename}
                              className="rounded-xl border border-fg/10 bg-fg/[0.03] px-3 py-2.5"
                            >
                              <p
                                className="truncate text-[12px] font-medium text-fg"
                                title={file.filename}
                              >
                                {file.filename}
                              </p>
                              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                <span className="rounded-md border border-accent/20 bg-accent/10 px-1.5 py-0.5 text-[9px] font-semibold text-accent/80">
                                  {file.quantization}
                                </span>
                                {rs && (
                                  <span
                                    className={cn(
                                      "rounded-md border px-1.5 py-0.5 text-[9px] font-semibold",
                                      rs.label === "excellent"
                                        ? "border-emerald-400/30 bg-emerald-400/15 text-emerald-500"
                                        : rs.label === "good"
                                          ? "border-blue-400/30 bg-blue-400/15 text-blue-500"
                                          : rs.label === "marginal"
                                            ? "border-amber-400/30 bg-amber-400/15 text-amber-500"
                                            : rs.label === "poor"
                                              ? "border-orange-400/30 bg-orange-400/15 text-orange-500"
                                              : "border-red-400/30 bg-red-400/15 text-red-500",
                                    )}
                                    title={`Runability: ${rs.score}/100 (${rs.label})${rs.fitsInRam ? " · Fits in RAM" : ""}${rs.fitsInVram ? " · Fits in VRAM" : ""}`}
                                  >
                                    {rs.score}
                                  </span>
                                )}
                                <span className="text-[12px] text-fg/45">
                                  {formatBytes(file.size)}
                                </span>
                              </div>
                              <button
                                onClick={() => queueDownload(modelInfo.modelId, file.filename)}
                                className={cn(
                                  "mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg border border-accent/30 bg-accent/15 py-1.5 text-[11px] font-semibold text-accent",
                                  interactive.transition.default,
                                  "hover:bg-accent/25 active:scale-[0.97]",
                                )}
                              >
                                <Download size={12} />
                                {t("hfBrowser.download")}
                              </button>
                            </div>
                          );
                          })}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Detailed resource report bottom sheet */}
      <BottomMenu
        isOpen={detailSheetOpen}
        onClose={() => setDetailSheetOpen(false)}
        title={t("hfBrowser.detailedReport")}
        includeExitIcon
      >
        {recData && (() => {
          const selFile = recData.files.find((f) => f.filename === recFile) || recData.files[0];
          if (!selFile) return null;

          const bpv = KV_BPV[recKvType] || 2;
          const totalAvail = recData.totalAvailable;
          const maxCtx = Math.max(maxContextForBpv(selFile.size, recData.kvBasePerToken, bpv, totalAvail, recData.modelMaxContext), 1024);
          const clampedCtx = Math.min(Math.max(recContext, 1024), maxCtx);
          const effectiveKvCtx = recData.kvContextCap
            ? Math.min(clampedCtx, recData.kvContextCap)
            : clampedCtx;
          const kvBytes = recData.kvBasePerToken
            ? recData.kvBasePerToken * bpv * effectiveKvCtx
            : 0;
          const overhead = computeOverhead(selFile.size);
          const totalNeeded = selFile.size + kvBytes + overhead;
          const headroom = Math.max(totalAvail - totalNeeded, 0);
          const vramBudget = recData.availableVram * 0.9;
          const { score, gpuMode } = calcScore(
            selFile.size,
            selFile.quantQuality,
            kvBytes,
            totalAvail,
            recData.availableVram,
          );

          const modelMax = recData.modelMaxContext;
          // Dynamic full-GPU context for current KV type
          const detailFullGpuCtx = (() => {
            if (recData.availableVram <= 0 || !recData.kvBasePerToken) return 0;
            if (selFile.size + overhead >= vramBudget) return 0;
            const vramForKv = vramBudget - selFile.size - overhead;
            const rawCtx = Math.floor(vramForKv / (recData.kvBasePerToken * bpv));
            if (recData.kvContextCap && rawCtx >= recData.kvContextCap) return modelMax;
            return rawCtx >= 512 ? Math.min(rawCtx, modelMax) : 0;
          })();
          // Dynamic max-RAM context for current KV type
          const detailMaxRamCtx = (() => {
            if (!recData.kvBasePerToken) return 0;
            const remaining = Math.max(totalAvail - selFile.size - overhead, 0);
            const rawCtx = Math.floor(remaining / (recData.kvBasePerToken * bpv));
            if (recData.kvContextCap && rawCtx >= recData.kvContextCap) return modelMax;
            return rawCtx >= 512 ? Math.min(rawCtx, modelMax) : 0;
          })();

          // Individual score components for breakdown (mirrors Rust score_configuration)
          const memoryScore = (() => {
            if (totalAvail === 0) return 50;
            if (totalNeeded > totalAvail) return 0;
            const r = totalAvail / totalNeeded;
            return r < 1.2 ? 20 : r < 1.5 ? 50 : r < 2.0 ? 70 : r < 3.0 ? 85 : 100;
          })();
          const gpuScore = (() => {
            if (recData.availableVram <= 0) return 0;
            if (totalNeeded <= vramBudget) return 100;
            if (selFile.size === 0) return 10;
            if (selFile.size <= vramBudget) {
              // Model fits, KV/compute spills
              const remaining = vramBudget - selFile.size;
              const spill = kvBytes + overhead;
              const fitRatio = spill > 0 ? Math.min(remaining / spill, 1.0) : 1.0;
              return Math.round(70 + fitRatio * 25);
            }
            // Model doesn't fit, partial layer offload
            const offloadRatio = Math.min(vramBudget / selFile.size, 1.0);
            return Math.round(10 + offloadRatio * 60);
          })();
          const kvScore = (() => {
            if (kvBytes === 0) return 50;
            const h = Math.max(totalAvail - selFile.size - overhead, 0);
            if (h === 0) return 0;
            if (h >= kvBytes) {
              const r = h / kvBytes;
              return r >= 2 ? 100 : Math.round(50 + 50 * (r - 1));
            }
            return Math.round(50 * (h / kvBytes));
          })();

          // GPU offload percentage: what % of total requirement fits in VRAM
          const offloadPct = (() => {
            if (recData.availableVram <= 0 || totalNeeded === 0) return 0;
            if (totalNeeded <= vramBudget) return 100;
            return Math.min(Math.round((vramBudget / totalNeeded) * 100), 99);
          })();

          // Recommended layers to offload (-ngl) for detail sheet
          const detailTotalLayers = recData.arch?.blockCount;
          const detailRecLayers = (() => {
            if (!detailTotalLayers || detailTotalLayers <= 0) return null;
            if (totalNeeded <= vramBudget) return detailTotalLayers;
            if (recData.availableVram <= 0) return null;
            const layers = Math.floor((vramBudget / totalNeeded) * detailTotalLayers);
            return Math.max(Math.min(layers, detailTotalLayers), 0);
          })();

          // Context tip: if KV is what pushes over VRAM, calculate max ctx for full GPU
          const fullGpuCtx = (() => {
            if (recData.availableVram <= 0 || !recData.kvBasePerToken) return null;
            if (totalNeeded <= vramBudget) return null; // already fits
            if (selFile.size + overhead >= vramBudget) return null; // model itself doesn't fit
            const vramForKv = vramBudget - selFile.size - overhead;
            const bpvVal = KV_BPV[recKvType] || 2;
            const maxCtxForGpu = Math.floor(vramForKv / (recData.kvBasePerToken * bpvVal));
            if (maxCtxForGpu < 512) return null; // too low to be useful
            return maxCtxForGpu;
          })();

          const row = (label: string, value: string, highlight?: string) => (
            <div className="flex items-center justify-between py-1.5">
              <span className="text-[11px] text-white/50">{label}</span>
              <span className={cn("text-[11px] font-mono font-medium", highlight || "text-white/80")}>
                {value}
              </span>
            </div>
          );

          const bar = (label: string, value: number, weight: number, color: string) => (
            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-white/50">{label} <span className="text-white/25">({Math.round(weight * 100)}%)</span></span>
                <span className={cn("text-[11px] font-mono font-semibold", color)}>{Math.round(value)}</span>
              </div>
              <div className="h-1 w-full rounded-full bg-white/10 overflow-hidden">
                <div
                  className={cn("h-full rounded-full transition-all", color.replace("text-", "bg-"))}
                  style={{ width: `${Math.min(value, 100)}%` }}
                />
              </div>
            </div>
          );

          const scoreColor = score >= 80 ? "text-emerald-400" : score >= 60 ? "text-blue-400" : score >= 40 ? "text-amber-400" : score >= 20 ? "text-orange-400" : "text-red-400";

          return (
            <div className="space-y-1">
              {/* System resources */}
              <MenuLabel>{t("hfBrowser.detailSystem")}</MenuLabel>
              <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-1 divide-y divide-white/5">
                {row(t("hfBrowser.detailRam"), formatBytes(recData.availableRam))}
                {row(t("hfBrowser.detailVram"), recData.availableVram > 0 ? formatBytes(recData.availableVram) : "—")}
                {recData.availableVram > 0 && row(t("hfBrowser.detailVramBudget"), formatBytes(vramBudget), "text-white/60")}
                {recData.unifiedMemory && row(t("hfBrowser.detailMemMode"), t("hfBrowser.detailUnified"), "text-amber-400")}
                {row(t("hfBrowser.detailTotalAvailable"), formatBytes(totalAvail))}
              </div>

              {/* Model architecture */}
              {recData.arch && (
                <>
                  <MenuLabel>{t("hfBrowser.detailArchitecture")}</MenuLabel>
                  <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-1 divide-y divide-white/5">
                    {recData.arch.architecture && row(t("hfBrowser.detailArch"), recData.arch.architecture.toUpperCase())}
                    {recData.arch.blockCount != null && row(t("hfBrowser.detailLayers"), recData.arch.blockCount.toString())}
                    {recData.arch.embeddingLength != null && row(t("hfBrowser.detailEmbedding"), recData.arch.embeddingLength.toLocaleString())}
                    {recData.arch.headCount != null && row(t("hfBrowser.detailHeads"), recData.arch.headCount.toString())}
                    {recData.arch.headCountKv != null && row(t("hfBrowser.detailKvHeads"), recData.arch.headCountKv.toString())}
                    {recData.arch.feedForwardLength != null && row(t("hfBrowser.detailFfn"), recData.arch.feedForwardLength.toLocaleString())}
                    {recData.arch.contextLength != null && row(t("hfBrowser.detailTrainCtx"), recData.arch.contextLength.toLocaleString())}
                    {recData.arch.slidingWindow != null && row(t("hfBrowser.detailSwa"), recData.arch.slidingWindow.toLocaleString())}
                    {recData.arch.kvLoraRank != null && row(t("hfBrowser.detailMlaRank"), recData.arch.kvLoraRank.toString())}
                    {recData.arch.incompleteParse && row(t("hfBrowser.detailParseStatus"), t("hfBrowser.detailIncomplete"), "text-amber-400")}
                  </div>
                </>
              )}

              <MenuDivider />

              {/* Current configuration */}
              <MenuLabel>{t("hfBrowser.detailConfig")}</MenuLabel>
              <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-1 divide-y divide-white/5">
                {row(t("hfBrowser.quantization"), selFile.quantization)}
                {row(t("hfBrowser.detailModelSize"), formatBytes(selFile.size))}
                {row(t("hfBrowser.contextLength"), clampedCtx.toLocaleString() + " tokens")}
                {row(t("hfBrowser.kvCacheType"), recKvType.toUpperCase())}
                {recData.kvContextCap && row(t("hfBrowser.detailEffectiveKvCtx"), effectiveKvCtx.toLocaleString() + " tokens", "text-white/60")}
                {detailFullGpuCtx > 0 && row(t("hfBrowser.detailOptimalGpuCtx"), detailFullGpuCtx.toLocaleString() + " tokens", "text-emerald-400")}
                {detailMaxRamCtx > 0 && row(t("hfBrowser.detailOptimalRamCtx"), detailMaxRamCtx.toLocaleString() + " tokens", "text-amber-400")}
              </div>

              {/* Memory breakdown */}
              <MenuLabel>{t("hfBrowser.detailMemory")}</MenuLabel>
              <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-1 divide-y divide-white/5">
                {row(t("hfBrowser.detailWeights"), formatBytes(selFile.size))}
                {row(t("hfBrowser.detailKvCache"), kvBytes > 0 ? formatBytes(kvBytes) : "—")}
                {row(t("hfBrowser.detailComputeBuffer"), formatBytes(overhead))}
                {row(t("hfBrowser.detailTotalNeeded"), formatBytes(totalNeeded), totalNeeded > totalAvail ? "text-red-400" : "text-emerald-400")}
                {row(t("hfBrowser.detailHeadroom"), headroom > 0 ? formatBytes(headroom) : "0 B", headroom > 0 ? "text-emerald-400/70" : "text-red-400/70")}
                {recData.availableVram > 0 && row(
                  t("hfBrowser.detailGpuFit"),
                  ({
                    full: t("hfBrowser.gpuFull"),
                    nearFull: t("hfBrowser.gpuNearFull"),
                    kvSpill: t("hfBrowser.gpuKvSpill"),
                    kvHeavySpill: t("hfBrowser.gpuKvHeavySpill"),
                    mostLayers: t("hfBrowser.gpuMostLayers"),
                    halfLayers: t("hfBrowser.gpuHalfLayers"),
                    fewLayers: t("hfBrowser.gpuFewLayers"),
                    cpu: t("hfBrowser.gpuCpu"),
                  }[gpuMode]) || t("hfBrowser.gpuCpu"),
                  ["full", "nearFull"].includes(gpuMode) ? "text-emerald-400"
                    : ["kvSpill", "mostLayers"].includes(gpuMode) ? "text-blue-400"
                    : ["kvHeavySpill", "halfLayers"].includes(gpuMode) ? "text-amber-400"
                    : "text-red-400",
                )}
                {recData.availableVram > 0 && row(t("hfBrowser.detailOffload"), `${offloadPct}%`,
                  offloadPct >= 100 ? "text-emerald-400" : offloadPct >= 50 ? "text-blue-400" : offloadPct > 0 ? "text-amber-400" : "text-red-400"
                )}
                {detailRecLayers != null && detailTotalLayers != null && detailRecLayers < detailTotalLayers && detailRecLayers > 0 &&
                  row(t("hfBrowser.detailLayers-ngl"), `${detailRecLayers} / ${detailTotalLayers}`,
                    detailRecLayers >= detailTotalLayers * 0.8 ? "text-blue-400" : detailRecLayers >= detailTotalLayers * 0.5 ? "text-amber-400" : "text-red-400"
                  )
                }
              </div>

              {/* KV Cache distribution */}
              {kvBytes > 0 && recData.availableVram > 0 && (() => {
                let kvVramPct: number;
                if (totalNeeded <= vramBudget) {
                  kvVramPct = 100; // everything fits
                } else if (selFile.size >= vramBudget) {
                  // Model doesn't fit — KV splits proportionally with layer offload
                  const layerRatio = Math.min(vramBudget / selFile.size, 1.0);
                  kvVramPct = Math.round(layerRatio * 100);
                } else {
                  // Model fits, KV partially spills
                  const vramForKv = vramBudget - selFile.size - overhead;
                  kvVramPct = vramForKv > 0 ? Math.min(Math.round((vramForKv / kvBytes) * 100), 100) : 0;
                }
                const kvRamPct = 100 - kvVramPct;
                const kvOnVram = kvBytes * (kvVramPct / 100);
                const kvOnRam = kvBytes - kvOnVram;

                return (
                  <>
                    <MenuLabel>{t("hfBrowser.detailKvDistribution")}</MenuLabel>
                    <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-1 divide-y divide-white/5">
                      {row(
                        t("hfBrowser.detailKvOnGpu"),
                        `${formatBytes(kvOnVram)} (${kvVramPct}%)`,
                        kvVramPct >= 80 ? "text-emerald-400" : kvVramPct >= 40 ? "text-blue-400" : "text-amber-400",
                      )}
                      {row(
                        t("hfBrowser.detailKvOnRam"),
                        `${formatBytes(kvOnRam)} (${kvRamPct}%)`,
                        kvRamPct === 0 ? "text-emerald-400/60" : kvRamPct <= 20 ? "text-blue-400" : "text-amber-400",
                      )}
                    </div>
                    {kvRamPct > 0 && (
                      <div className="flex items-start gap-2 rounded-xl border border-amber-400/15 bg-amber-400/5 px-3 py-2 mt-1">
                        <Info size={12} className="text-amber-400 shrink-0 mb-0.5" />
                        <p className="text-[12px] leading-snug text-amber-300/70">
                          {t("hfBrowser.kvDistributionTip", { pct: kvRamPct.toString() })}
                        </p>
                      </div>
                    )}
                  </>
                );
              })()}


              {/* Context tip */}
              {fullGpuCtx && fullGpuCtx < clampedCtx && (
                <div className="flex items-start gap-2 rounded-xl border border-blue-400/20 bg-blue-400/5 px-3 py-2 mt-1">
                  <Info size={12} className="text-blue-400 shrink-0 mt-0.5" />
                  <p className="text-[12px] leading-snug text-blue-300/80">
                    {t("hfBrowser.detailCtxTip", { ctx: fullGpuCtx.toLocaleString() })}
                  </p>
                </div>
              )}

              <MenuDivider />

              {/* Score breakdown */}
              <MenuLabel>{t("hfBrowser.detailScoreBreakdown")}</MenuLabel>
              <div className="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 space-y-3">
                {bar(t("hfBrowser.detailMemFitness"), memoryScore, 0.25,
                  memoryScore >= 70 ? "text-emerald-400" : memoryScore >= 40 ? "text-amber-400" : "text-red-400")}
                {bar(t("hfBrowser.detailGpuAccel"), gpuScore, 0.35,
                  gpuScore >= 75 ? "text-emerald-400" : gpuScore >= 35 ? "text-amber-400" : "text-red-400")}
                {bar(t("hfBrowser.detailKvHeadroom"), kvScore, 0.15,
                  kvScore >= 70 ? "text-emerald-400" : kvScore >= 40 ? "text-amber-400" : "text-red-400")}
                {bar(t("hfBrowser.detailQuantQuality"), selFile.quantQuality, 0.25,
                  selFile.quantQuality >= 75 ? "text-emerald-400" : selFile.quantQuality >= 50 ? "text-amber-400" : "text-red-400")}
              </div>

              {/* Final score */}
              <div className="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 mt-2">
                <span className="text-[12px] font-semibold text-white/70">{t("hfBrowser.detailFinalScore")}</span>
                <span className={cn("text-2xl font-bold", scoreColor)}>{score}</span>
              </div>
            </div>
          );
        })()}
      </BottomMenu>
    </div>
  );
}
