import { useEffect, useMemo, useState, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Hook to load attachment data from storage when only storagePath is available.
 * Returns the data URL for the image, loading it from disk if needed.
 *
 * @param data - The inline base64 data URL (if already loaded)
 * @param storagePath - The relative storage path to load from disk
 * @returns The data URL for display, or undefined if loading/not available
 */
export function useSessionAttachment(
  data: string | undefined | null,
  storagePath: string | undefined | null,
): string | undefined {
  const [loadedData, setLoadedData] = useState<string | undefined>(undefined);
  const lastPathRef = useRef<string | null | undefined>(undefined);
  const loadingRef = useRef<boolean>(false);
  const requestVersionRef = useRef<number>(0);

  useEffect(() => {
    const requestVersion = ++requestVersionRef.current;

    if (data) {
      setLoadedData(data);
      return;
    }

    if (!storagePath) {
      setLoadedData(undefined);
      return;
    }

    if (lastPathRef.current === storagePath && loadedData !== undefined) {
      return;
    }

    // Avoid concurrent loads
    if (loadingRef.current) {
      return;
    }

    loadingRef.current = true;
    lastPathRef.current = storagePath;

    invoke<string>("storage_load_session_attachment", { storagePath })
      .then((dataUrl) => {
        if (requestVersionRef.current !== requestVersion) {
          return;
        }
        setLoadedData(dataUrl);
        loadingRef.current = false;
      })
      .catch((err) => {
        if (requestVersionRef.current !== requestVersion) {
          return;
        }
        console.error("[useSessionAttachment] Failed to load attachment:", storagePath, err);
        setLoadedData(undefined);
        loadingRef.current = false;
      });
  }, [data, storagePath, loadedData]);

  return loadedData;
}

/**
 * Interface for attachment with optional data/storagePath
 */
interface LazyAttachment {
  id: string;
  data?: string | null;
  storagePath?: string | null;
  mimeType?: string;
  filename?: string | null;
  width?: number | null;
  height?: number | null;
}

const MAX_ATTACHMENT_CACHE_ENTRIES = 300;

function pruneCacheMap<T>(map: Map<string, T>, validIds: Set<string>) {
  for (const key of map.keys()) {
    if (!validIds.has(key)) {
      map.delete(key);
    }
  }
}

function trimCacheToLimit<T>(map: Map<string, T>, limit: number) {
  if (map.size <= limit) return;
  const removeCount = map.size - limit;
  let removed = 0;
  for (const key of map.keys()) {
    map.delete(key);
    removed += 1;
    if (removed >= removeCount) break;
  }
}

/**
 * Hook to load multiple attachments with lazy loading support.
 * Returns attachments with their data loaded from storage if needed.
 */
export function useSessionAttachments(
  attachments: LazyAttachment[] | undefined | null,
): LazyAttachment[] {
  const [loadedAttachments, setLoadedAttachments] = useState<LazyAttachment[]>([]);
  const dataMapRef = useRef<Map<string, string>>(new Map());
  const requestVersionRef = useRef<number>(0);
  const attachmentsKey = useMemo(
    () =>
      (attachments ?? [])
        .map(
          (att) =>
            `${att.id}:${att.storagePath ?? ""}:${att.data ? att.data.length : 0}:${att.width ?? ""}:${att.height ?? ""}`,
        )
        .join("|"),
    [attachments],
  );

  useEffect(() => {
    const requestVersion = ++requestVersionRef.current;
    let cancelled = false;

    if (!attachments || attachments.length === 0) {
      setLoadedAttachments([]);
      dataMapRef.current.clear();
      return;
    }

    const validIds = new Set(attachments.map((att) => att.id));
    pruneCacheMap(dataMapRef.current, validIds);

    // Check which attachments need loading
    const toLoad: LazyAttachment[] = [];
    const result: LazyAttachment[] = [];

    for (const att of attachments) {
      if (att.data) {
        result.push(att);
        dataMapRef.current.set(att.id, att.data);
        continue;
      }

      const cachedData = dataMapRef.current.get(att.id);
      if (cachedData) {
        result.push({ ...att, data: cachedData });
        continue;
      }

      if (att.storagePath) {
        toLoad.push(att);
        result.push(att);
      } else {
        result.push(att);
      }
    }

    setLoadedAttachments(result);

    if (toLoad.length > 0) {
      for (const att of toLoad) {
        if (!att.storagePath) continue;

        invoke<string>("storage_load_session_attachment", { storagePath: att.storagePath })
          .then((dataUrl) => {
            if (cancelled || requestVersionRef.current !== requestVersion) {
              return;
            }
            dataMapRef.current.set(att.id, dataUrl);

            setLoadedAttachments((prev) =>
              prev.map((a) => (a.id === att.id ? { ...a, data: dataUrl } : a)),
            );
            trimCacheToLimit(dataMapRef.current, MAX_ATTACHMENT_CACHE_ENTRIES);
          })
          .catch((err) => {
            if (cancelled || requestVersionRef.current !== requestVersion) return;
            console.error("[useSessionAttachments] Failed to load:", att.storagePath, err);
          });
      }
    }

    return () => {
      cancelled = true;
    };
  }, [attachmentsKey]);

  return loadedAttachments;
}
