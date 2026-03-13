import { useCallback, useEffect, useReducer, useRef } from "react";

import {
  createSession,
  createBranchedSession,
  createBranchedSessionToCharacter,
  getDefaultPersona,
  getSession,
  getSessionMeta,
  deleteMessage,
  deleteMessagesAfter,
  listCharacters,
  listMessages,
  listPersonas,
  listSessionPreviews,
  saveSession,
  SETTINGS_UPDATED_EVENT,
  SESSION_UPDATED_EVENT,
  readSettings,
  toggleMessagePin,
} from "../../../../core/storage/repo";
import type {
  Character,
  Persona,
  Session,
  Scene,
  StoredMessage,
  ImageAttachment,
} from "../../../../core/storage/schemas";
import { abortMessage, addChatMessageAttachment } from "../../../../core/chat/manager";
import {
  chatReducer,
  initialChatState,
  type ChatState,
  type MessageActionState,
} from "./chatReducer";
import { getLiveChatState, subscribeToLiveChatState } from "./chatLiveState";
import { useChatStreamingController } from "./useChatStreamingController";
import { logManager } from "../../../../core/utils/logger";
import { generateImage, type ImageGenerationRequest } from "../../../../core/image-generation";
import type { GeneratedImage } from "../../../../core/image-generation";
import { convertFileSrc } from "@tauri-apps/api/core";
import { type as getPlatform } from "@tauri-apps/plugin-os";
import { impactFeedback } from "@tauri-apps/plugin-haptics";
import { confirmBottomMenu } from "../../../components/ConfirmBottomMenu";

const INITIAL_MESSAGE_LIMIT = 50;
const OLDER_MESSAGE_PAGE = 50;
const IMAGE_DIRECTIVE_RE = /<<image:(\{[\s\S]*?\})>>/g;

// Global lock to prevent concurrent session saves
const sessionSaveQueue = new Map<string, Promise<void>>();

/**
 * Safely saves a session with locking to prevent race conditions.
 * Uses per-session locks to allow different sessions to be saved concurrently
 * but serializes saves to the same session.
 */
async function safeSaveSession(session: Session): Promise<void> {
  const sessionId = session.id;

  const pendingSave = sessionSaveQueue.get(sessionId);
  if (pendingSave) {
    await pendingSave;
  }

  const savePromise = saveSession(session).finally(() => {
    if (sessionSaveQueue.get(sessionId) === savePromise) {
      sessionSaveQueue.delete(sessionId);
    }
  });

  sessionSaveQueue.set(sessionId, savePromise);
  return savePromise;
}

export interface VariantState {
  variants: StoredMessage["variants"];
  selectedIndex: number;
  total: number;
}

export interface ChatController {
  // State
  character: Character | null;
  persona: Persona | null;
  session: Session | null;
  messages: StoredMessage[];
  draft: string;
  loading: boolean;
  sending: boolean;
  error: string | null;
  messageAction: MessageActionState | null;
  actionError: string | null;
  actionStatus: string | null;
  actionBusy: boolean;
  editDraft: string;
  heldMessageId: string | null;
  regeneratingMessageId: string | null;
  activeRequestId: string | null;
  pendingAttachments: ImageAttachment[];
  streamingReasoning: Record<string, string>;
  hasMoreMessagesBefore: boolean;
  loadOlderMessages: () => Promise<void>;
  ensureMessageLoaded: (messageId: string) => Promise<void>;

  // Setters
  setDraft: (value: string) => void;
  setError: (value: string | null) => void;
  setMessageAction: (value: MessageActionState | null) => void;
  setActionError: (value: string | null) => void;
  setActionStatus: (value: string | null) => void;
  setActionBusy: (value: boolean) => void;
  setEditDraft: (value: string) => void;
  setHeldMessageId: (value: string | null) => void;
  setPendingAttachments: (attachments: ImageAttachment[]) => void;
  addPendingAttachment: (attachment: ImageAttachment) => void;
  removePendingAttachment: (attachmentId: string) => void;
  clearPendingAttachments: () => void;

  // Actions
  handleSend: (
    message: string,
    attachments?: ImageAttachment[],
    options?: { swapPlaces?: boolean },
  ) => Promise<void>;
  handleContinue: (options?: { swapPlaces?: boolean }) => Promise<void>;
  handleRegenerate: (message: StoredMessage, options?: { swapPlaces?: boolean }) => Promise<void>;
  handleAbort: () => Promise<void>;
  getVariantState: (message: StoredMessage) => VariantState;
  applyVariantSelection: (messageId: string, variantId: string) => Promise<void>;
  handleVariantSwipe: (messageId: string, direction: "prev" | "next") => Promise<void>;
  handleVariantDrag: (messageId: string, offsetX: number) => Promise<void>;
  handleSaveEdit: () => Promise<void>;
  handleDeleteMessage: (message: StoredMessage) => Promise<void>;
  handleRewindToMessage: (message: StoredMessage) => Promise<void>;
  handleBranchFromMessage: (message: StoredMessage) => Promise<string | null>;
  handleBranchToCharacter: (
    message: StoredMessage,
    targetCharacterId: string,
  ) => Promise<{ sessionId: string; characterId: string } | null>;
  handleTogglePin: (message: StoredMessage) => Promise<void>;
  resetMessageActions: () => void;
  initializeLongPressTimer: (id: number | null) => void;
  isStartingSceneMessage: (message: StoredMessage) => boolean;
}

/**
 * Helper function to determine if a message is the starting scene message.
 * A starting scene message has the "scene" role.
 */
function isStartingSceneMessage(message: StoredMessage): boolean {
  return message.role === "scene";
}

function resolveSceneContent(scene: Scene): string {
  if (scene.selectedVariantId) {
    const selectedVariant = scene.variants?.find(
      (variant) => variant.id === scene.selectedVariantId,
    );
    if (selectedVariant?.content?.trim()) {
      return selectedVariant.content;
    }
  }
  if (scene.content?.trim()) {
    return scene.content;
  }
  return scene.direction?.trim() ?? "";
}

function normalizeStartingSceneMessage(
  messages: StoredMessage[],
  character: Character,
  selectedSceneId?: string | null,
): StoredMessage[] {
  const sceneMessageIndex = messages.findIndex((message) => isStartingSceneMessage(message));
  if (sceneMessageIndex < 0) {
    return messages;
  }

  const selectedScene =
    character.scenes.find((scene) => scene.id === selectedSceneId) ??
    character.scenes.find((scene) => scene.id === character.defaultSceneId) ??
    character.scenes[0];
  if (!selectedScene) {
    return messages;
  }

  const expectedSceneContent = resolveSceneContent(selectedScene).trim();
  if (!expectedSceneContent) {
    return messages;
  }

  const currentSceneMessage = messages[sceneMessageIndex];
  if (currentSceneMessage.content.trim() === expectedSceneContent) {
    return messages;
  }

  const nextMessages = [...messages];
  nextMessages[sceneMessageIndex] = {
    ...currentSceneMessage,
    content: expectedSceneContent,
  };
  return nextMessages;
}

export function useChatController(
  characterId?: string,
  options: { sessionId?: string } = {},
): ChatController {
  const log = logManager({ component: "useChatController" });
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const { sessionId } = options;

  const longPressTimerRef = useRef<number | null>(null);
  const messagesRef = useRef<StoredMessage[]>([]);
  const hasMoreMessagesBeforeRef = useRef<boolean>(true);
  const loadingOlderRef = useRef<boolean>(false);
  const sessionOperationRef = useRef<boolean>(false);
  const lastKnownSessionTimestampRef = useRef<number>(0);
  const processedImageDirectiveMessagesRef = useRef<Set<string>>(new Set());
  const imageGenConfigRef = useRef<{
    modelName: string;
    providerId: string;
    credentialId: string;
  } | null>(null);
  const hapticsEnabledRef = useRef<boolean>(false);
  const hapticIntensityRef = useRef<any>("light");
  const lastHapticTimeRef = useRef<number>(0);
  const platformRef = useRef<string>("");

  useEffect(() => {
    platformRef.current = getPlatform();
    const updateHapticsState = async () => {
      try {
        const settings = await readSettings();
        const acc = settings.advancedSettings?.accessibility;
        hapticsEnabledRef.current = acc?.haptics ?? false;
        hapticIntensityRef.current = acc?.hapticIntensity ?? "light";
      } catch (e) {
        // silence errors
      }
    };
    void updateHapticsState();
    window.addEventListener(SETTINGS_UPDATED_EVENT, updateHapticsState);
    return () => window.removeEventListener(SETTINGS_UPDATED_EVENT, updateHapticsState);
  }, []);

  const triggerTypingHaptic = useCallback(async () => {
    if (!hapticsEnabledRef.current) return;
    const isMobile = platformRef.current === "android" || platformRef.current === "ios";
    if (!isMobile) return;

    const now = Date.now();
    // Throttle haptics to at most once every 60ms to keep pulses distinct
    if (now - lastHapticTimeRef.current < 60) return;

    lastHapticTimeRef.current = now;
    try {
      await impactFeedback(hapticIntensityRef.current);
    } catch (e) {
      // ignore
    }
  }, []);

  const resolveDefaultImageGenConfig = useCallback(async () => {
    if (imageGenConfigRef.current) return imageGenConfigRef.current;
    const settings = await readSettings();
    const imageModels = settings.models.filter((m) => m.outputScopes?.includes("image"));
    const firstModel = imageModels[0];
    if (!firstModel) return null;

    const providerCreds = settings.providerCredentials;
    const provider =
      providerCreds.find(
        (p) => p.providerId === firstModel.providerId && p.label === firstModel.providerLabel,
      ) ??
      providerCreds.find((p) => p.providerId === firstModel.providerId) ??
      null;
    if (!provider) return null;

    const cfg = {
      modelName: firstModel.name,
      providerId: firstModel.providerId,
      credentialId: provider.id,
    };
    imageGenConfigRef.current = cfg;
    return cfg;
  }, []);

  const dataUrlFromGeneratedImage = useCallback(
    async (generated: GeneratedImage): Promise<string> => {
      if (generated.url && generated.url.startsWith("data:")) {
        return generated.url;
      }

      const src = generated.url || (generated.filePath ? convertFileSrc(generated.filePath) : null);
      if (!src) {
        throw new Error("Generated image has no url or filePath");
      }
      const response = await fetch(src);
      const blob = await response.blob();

      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result as string);
        reader.onerror = () => reject(new Error("Failed to read image blob"));
        reader.readAsDataURL(blob);
      });

      return dataUrl;
    },
    [],
  );

  const imageInfoFromDataUrl = useCallback(async (dataUrl: string) => {
    const mimeMatch = dataUrl.match(/^data:([^;]+);base64,/);
    const mimeType = mimeMatch?.[1] ?? "image/png";

    const dims = await new Promise<{ width: number; height: number }>((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ width: img.width, height: img.height });
      img.onerror = () => resolve({ width: 0, height: 0 });
      img.src = dataUrl;
    });

    return { mimeType, width: dims.width || undefined, height: dims.height || undefined };
  }, []);

  const parseImageDirectives = useCallback((content: string) => {
    const directives: Array<{
      prompt: string;
      size?: string;
      n?: number;
      quality?: string;
      style?: string;
    }> = [];
    IMAGE_DIRECTIVE_RE.lastIndex = 0;
    const clean = content.replace(IMAGE_DIRECTIVE_RE, (_full, jsonStr) => {
      try {
        const parsed = JSON.parse(jsonStr);
        const prompt = typeof parsed?.prompt === "string" ? parsed.prompt.trim() : "";
        if (!prompt) return "";
        directives.push({
          prompt,
          size: typeof parsed?.size === "string" ? parsed.size : undefined,
          n: typeof parsed?.n === "number" ? parsed.n : undefined,
          quality: typeof parsed?.quality === "string" ? parsed.quality : undefined,
          style: typeof parsed?.style === "string" ? parsed.style : undefined,
        });
      } catch {
        return _full;
      }
      return "";
    });
    return { cleanContent: clean.trim(), directives };
  }, []);

  const parseSize = useCallback((size?: string) => {
    if (!size) return null;
    const m = size.match(/^(\d+)\s*x\s*(\d+)$/i);
    if (!m) return null;
    const w = Number(m[1]);
    const h = Number(m[2]);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
    return { width: w, height: h };
  }, []);

  const runInChatImageGeneration = useCallback(
    async (assistantMessageId: string) => {
      if (!state.session || !state.character) return;
      if (processedImageDirectiveMessagesRef.current.has(assistantMessageId)) return;

      const current = messagesRef.current.find((m) => m.id === assistantMessageId);
      if (!current) return;

      const { cleanContent, directives } = parseImageDirectives(current.content);
      if (directives.length === 0) return;

      const cfg = await resolveDefaultImageGenConfig();
      if (!cfg) return;

      processedImageDirectiveMessagesRef.current.add(assistantMessageId);

      const placeholderAttachments: ImageAttachment[] = [];
      for (const directive of directives) {
        const count = Math.max(1, Math.min(4, directive.n ?? 1));
        const dims = parseSize(directive.size) ?? parseSize("1024x1024");
        for (let i = 0; i < count; i++) {
          placeholderAttachments.push({
            id: crypto.randomUUID(),
            data: "",
            mimeType: "image/webp",
            width: dims?.width,
            height: dims?.height,
          });
        }
      }

      const updatedMessage: StoredMessage = {
        ...current,
        content: cleanContent,
        attachments: [...(current.attachments ?? []), ...placeholderAttachments],
      };

      const updatedMessages = messagesRef.current.map((m) =>
        m.id === assistantMessageId ? updatedMessage : m,
      );
      messagesRef.current = updatedMessages;

      const updatedSession: Session = {
        ...state.session,
        messages: updatedMessages,
        updatedAt: Date.now(),
      };

      dispatch({
        type: "BATCH",
        actions: [
          { type: "SET_MESSAGES", payload: updatedMessages },
          { type: "SET_SESSION", payload: updatedSession },
        ],
      });

      try {
        sessionOperationRef.current = true;
        await safeSaveSession(updatedSession);
        lastKnownSessionTimestampRef.current = updatedSession.updatedAt;
      } finally {
        sessionOperationRef.current = false;
      }

      for (let dIndex = 0, pIndex = 0; dIndex < directives.length; dIndex++) {
        const directive = directives[dIndex];
        const n = Math.max(1, Math.min(4, directive.n ?? 1));
        const placeholdersForDirective = placeholderAttachments.slice(pIndex, pIndex + n);
        pIndex += n;

        const request: ImageGenerationRequest = {
          prompt: directive.prompt,
          model: cfg.modelName,
          providerId: cfg.providerId,
          credentialId: cfg.credentialId,
          size: directive.size ?? "1024x1024",
          n,
          quality: directive.quality,
          style: directive.style,
        };

        try {
          const response = await generateImage(request);
          const images = response.images.slice(0, placeholdersForDirective.length);
          for (let i = 0; i < images.length; i++) {
            const placeholderId = placeholdersForDirective[i]?.id;
            if (!placeholderId) continue;

            const dataUrl = await dataUrlFromGeneratedImage(images[i]);
            const info = await imageInfoFromDataUrl(dataUrl);

            const updated = await addChatMessageAttachment({
              sessionId: state.session.id,
              characterId: state.character.id,
              messageId: assistantMessageId,
              role: "assistant",
              attachmentId: placeholderId,
              base64Data: dataUrl,
              mimeType: info.mimeType,
              width: info.width,
              height: info.height,
            });

            const nextMessages = messagesRef.current.map((m) =>
              m.id === updated.id ? updated : m,
            );
            messagesRef.current = nextMessages;
            dispatch({ type: "SET_MESSAGES", payload: nextMessages });
          }
        } catch (err) {
          console.error("In-chat image generation failed:", err);
          const ids = new Set(placeholdersForDirective.map((p) => p.id));
          const currentMsg = messagesRef.current.find((m) => m.id === assistantMessageId);
          if (currentMsg && ids.size > 0) {
            const cleanedMessage: StoredMessage = {
              ...currentMsg,
              attachments: (currentMsg.attachments ?? []).filter((att) => !ids.has(att.id)),
            };
            const nextMessages = messagesRef.current.map((m) =>
              m.id === cleanedMessage.id ? cleanedMessage : m,
            );
            messagesRef.current = nextMessages;
            const updatedSession: Session = {
              ...state.session,
              messages: nextMessages,
              updatedAt: Date.now(),
            };
            dispatch({
              type: "BATCH",
              actions: [
                { type: "SET_MESSAGES", payload: nextMessages },
                { type: "SET_SESSION", payload: updatedSession },
              ],
            });
            try {
              sessionOperationRef.current = true;
              await safeSaveSession(updatedSession);
              lastKnownSessionTimestampRef.current = updatedSession.updatedAt;
            } finally {
              sessionOperationRef.current = false;
            }
          }
        }
      }
    },
    [
      addChatMessageAttachment,
      dataUrlFromGeneratedImage,
      imageInfoFromDataUrl,
      parseImageDirectives,
      parseSize,
      resolveDefaultImageGenConfig,
      state.character,
      state.session,
    ],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = async () => {
      if (sessionOperationRef.current) {
        log.info("Skipping settings reload - session operation in progress");
        return;
      }

      if (characterId && state.character) {
        try {
          const list = await listCharacters();
          const match = list.find((c) => c.id === characterId) ?? null;
          if (match) {
            dispatch({ type: "SET_CHARACTER", payload: match });
          }
        } catch (err) {
          log.error("Failed to reload character on settings change", err);
        }
      }
    };
    window.addEventListener(SETTINGS_UPDATED_EVENT, handler);
    return () => {
      window.removeEventListener(SETTINGS_UPDATED_EVENT, handler);
    };
  }, [characterId, state.character, log]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!state.session?.id) return;

    let cancelled = false;

    const handler = async () => {
      try {
        const latest = await getSessionMeta(state.session!.id);
        if (!latest || cancelled) return;
        if (state.character && latest.characterId !== state.character.id) return;

        const normalizedSession: Session = {
          ...latest,
          messages: messagesRef.current,
        };
        const personaDisabled =
          normalizedSession.personaDisabled || normalizedSession.personaId === "";
        let selectedPersona: Persona | null = null;
        if (!personaDisabled && normalizedSession.personaId) {
          const allPersonas = await listPersonas().catch(() => [] as Persona[]);
          selectedPersona = allPersonas.find((p) => p.id === normalizedSession.personaId) ?? null;
        }
        if (!selectedPersona && !personaDisabled) {
          selectedPersona = await getDefaultPersona().catch((err) => {
            console.warn("ChatController: failed to load persona", err);
            return null;
          });
        }

        if (cancelled) return;
        lastKnownSessionTimestampRef.current = normalizedSession.updatedAt;
        dispatch({
          type: "BATCH",
          actions: [
            { type: "SET_PERSONA", payload: selectedPersona },
            { type: "SET_SESSION", payload: normalizedSession },
          ],
        });
      } catch (err) {
        console.warn("ChatController: failed to sync session update", err);
      }
    };

    window.addEventListener(SESSION_UPDATED_EVENT, handler);
    return () => {
      cancelled = true;
      window.removeEventListener(SESSION_UPDATED_EVENT, handler);
    };
  }, [state.character, state.session?.id]);

  useEffect(() => {
    if (!characterId) return;

    let cancelled = false;

    (async () => {
      try {
        dispatch({
          type: "BATCH",
          actions: [
            { type: "SET_LOADING", payload: true },
            { type: "SET_ERROR", payload: null },
          ],
        });

        const list = await listCharacters();
        const match = list.find((c) => c.id === characterId) ?? null;
        if (!match) {
          if (!cancelled) {
            dispatch({ type: "SET_CHARACTER", payload: null });
          }
          return;
        }

        let targetSession: Session | null = null;

        if (sessionId) {
          const explicitSession = await getSessionMeta(sessionId).catch((err) => {
            console.warn("ChatController: failed to load requested session", { sessionId, err });
            return null;
          });
          if (explicitSession && explicitSession.characterId === match.id) {
            targetSession = explicitSession;
          }
        }

        if (!targetSession) {
          const previews = await listSessionPreviews(match.id, 1).catch(() => []);
          const latestId = previews[0]?.id;
          if (latestId) {
            targetSession = await getSessionMeta(latestId).catch((err) => {
              console.warn("ChatController: failed to load latest session", { latestId, err });
              return null;
            });
          }
        }

        if (!targetSession) {
          targetSession = await createSession(
            match.id,
            match.name ?? "New chat",
            match.defaultSceneId ?? match.scenes?.[0]?.id,
          );
        }

        let orderedMessages: StoredMessage[] = [];
        if (targetSession.messages && targetSession.messages.length > 0) {
          orderedMessages = [...targetSession.messages].sort((a, b) => a.createdAt - b.createdAt);
          hasMoreMessagesBeforeRef.current = false;
        } else {
          const fetched = await listMessages(targetSession.id, {
            limit: INITIAL_MESSAGE_LIMIT,
          }).catch((err) => {
            console.warn("ChatController: failed to load recent messages", {
              sessionId: targetSession?.id,
              err,
            });
            return [] as StoredMessage[];
          });
          orderedMessages = [...fetched].sort((a, b) => a.createdAt - b.createdAt);
          hasMoreMessagesBeforeRef.current = orderedMessages.length >= INITIAL_MESSAGE_LIMIT;
        }

        orderedMessages = normalizeStartingSceneMessage(
          orderedMessages,
          match,
          targetSession.selectedSceneId,
        );

        messagesRef.current = orderedMessages;
        const normalizedSession: Session = { ...targetSession, messages: orderedMessages };

        // Load persona: prefer session's personaId, fallback to default unless explicitly disabled.
        const personaDisabled =
          normalizedSession.personaDisabled || normalizedSession.personaId === "";
        let selectedPersona: Persona | null = null;
        if (!personaDisabled && normalizedSession.personaId) {
          const allPersonas = await listPersonas().catch(() => [] as Persona[]);
          selectedPersona = allPersonas.find((p) => p.id === normalizedSession.personaId) ?? null;
        }
        if (!selectedPersona && !personaDisabled) {
          selectedPersona = await getDefaultPersona().catch((err) => {
            console.warn("ChatController: failed to load persona", err);
            return null;
          });
        }

        if (!cancelled) {
          // Track the last known timestamp to detect stale saves
          lastKnownSessionTimestampRef.current = normalizedSession.updatedAt;
          dispatch({
            type: "BATCH",
            actions: [
              { type: "SET_CHARACTER", payload: match },
              { type: "SET_PERSONA", payload: selectedPersona },
              { type: "SET_SESSION", payload: normalizedSession },
              { type: "SET_MESSAGES", payload: orderedMessages },
            ],
          });
        }
      } catch (err) {
        console.error("ChatController: failed to load chat", err);
        if (!cancelled) {
          dispatch({
            type: "SET_ERROR",
            payload: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        if (!cancelled) {
          dispatch({ type: "SET_LOADING", payload: false });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [characterId, sessionId]);

  useEffect(() => {
    messagesRef.current = state.messages;
  }, [state.messages]);

  useEffect(() => {
    const liveSessionId = state.session?.id ?? sessionId;
    if (!liveSessionId) return;

    const applySnapshot = (snapshot: ChatState | null) => {
      if (!snapshot) return;
      messagesRef.current = snapshot.messages;
      dispatch({
        type: "BATCH",
        actions: [
          ...(snapshot.session
            ? [{ type: "SET_SESSION" as const, payload: snapshot.session }]
            : []),
          { type: "SET_MESSAGES", payload: snapshot.messages },
          { type: "SET_SENDING", payload: snapshot.sending },
          { type: "SET_ERROR", payload: snapshot.error },
          { type: "SET_REGENERATING_MESSAGE_ID", payload: snapshot.regeneratingMessageId },
          { type: "SET_ACTIVE_REQUEST_ID", payload: snapshot.activeRequestId },
          { type: "SET_STREAMING_REASONING", payload: snapshot.streamingReasoning },
        ],
      });
    };

    applySnapshot(getLiveChatState(liveSessionId) ?? null);
    return subscribeToLiveChatState(liveSessionId, applySnapshot);
  }, [sessionId, state.session?.id]);

  const reloadSessionStateFromStorage = useCallback(
    async (sessionId: string) => {
      const limit = Math.max(
        INITIAL_MESSAGE_LIMIT,
        messagesRef.current.filter((message) => !message.id.startsWith("placeholder-")).length,
      );
      const [meta, storedMessages] = await Promise.all([
        getSessionMeta(sessionId).catch(() => null),
        listMessages(sessionId, { limit }).catch(() => [] as StoredMessage[]),
      ]);

      const orderedMessagesSource =
        storedMessages.length > 0 ? storedMessages : (meta?.messages ?? []);
      let orderedMessages = [...orderedMessagesSource].sort((a, b) => a.createdAt - b.createdAt);
      if (state.character) {
        orderedMessages = normalizeStartingSceneMessage(
          orderedMessages,
          state.character,
          meta?.selectedSceneId ?? state.session?.selectedSceneId,
        );
      }

      messagesRef.current = orderedMessages;
      hasMoreMessagesBeforeRef.current = orderedMessages.length >= limit;

      if (meta) {
        dispatch({
          type: "BATCH",
          actions: [
            { type: "SET_SESSION", payload: { ...meta, messages: orderedMessages } },
            { type: "SET_MESSAGES", payload: orderedMessages },
          ],
        });
        return;
      }

      dispatch({ type: "SET_MESSAGES", payload: orderedMessages });
    },
    [state.character, state.session],
  );

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const resetMessageActions = useCallback(() => {
    dispatch({ type: "RESET_MESSAGE_ACTIONS" });
  }, []);

  const getVariantState = useCallback(
    (message: StoredMessage): VariantState => {
      if (isStartingSceneMessage(message)) {
        if (!state.character || !state.session?.selectedSceneId) {
          return { variants: [], selectedIndex: -1, total: 0 };
        }

        const currentSceneIndex = state.character.scenes.findIndex(
          (s) => s.id === state.session!.selectedSceneId,
        );

        return {
          variants: state.character.scenes as any,
          selectedIndex: currentSceneIndex,
          total: state.character.scenes.length,
        };
      }

      const variants = message.variants ?? [];
      if (variants.length === 0) {
        return {
          variants,
          selectedIndex: -1,
          total: 0,
        };
      }
      const explicitIndex = message.selectedVariantId
        ? variants.findIndex((variant) => variant.id === message.selectedVariantId)
        : -1;
      const selectedIndex = explicitIndex >= 0 ? explicitIndex : variants.length - 1;
      return {
        variants,
        selectedIndex,
        total: variants.length,
      };
    },
    [state.character, state.messages, state.session],
  );

  const loadOlderMessages = useCallback(async () => {
    if (!state.session) return;
    if (!hasMoreMessagesBeforeRef.current) return;
    if (loadingOlderRef.current) return;
    const first = messagesRef.current[0];
    if (!first) return;

    loadingOlderRef.current = true;
    try {
      const older = await listMessages(state.session.id, {
        limit: OLDER_MESSAGE_PAGE,
        before: { createdAt: first.createdAt, id: first.id },
      });
      if (older.length === 0) {
        hasMoreMessagesBeforeRef.current = false;
        return;
      }
      const merged = [...older, ...messagesRef.current];
      const seen = new Set<string>();
      const deduped = merged.filter((m) => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });
      messagesRef.current = deduped;
      hasMoreMessagesBeforeRef.current = older.length >= OLDER_MESSAGE_PAGE;
      dispatch({ type: "SET_MESSAGES", payload: deduped });
      if (state.session) {
        dispatch({ type: "SET_SESSION", payload: { ...state.session, messages: deduped } });
      }
    } catch (err) {
      console.warn("ChatController: failed to load older messages", err);
    } finally {
      loadingOlderRef.current = false;
    }
  }, [state.session]);

  const ensureMessageLoaded = useCallback(
    async (messageId: string) => {
      const maxPages = 20;
      for (let i = 0; i < maxPages; i++) {
        if (messagesRef.current.some((m) => m.id === messageId)) return;
        if (!hasMoreMessagesBeforeRef.current) return;
        await loadOlderMessages();
      }
    },
    [loadOlderMessages],
  );

  const applyVariantSelection = useCallback(
    async (messageId: string, variantId: string) => {
      if (!state.session || state.regeneratingMessageId) return;
      const currentMessage = state.messages.find((msg) => msg.id === messageId);
      if (!currentMessage) return;
      const variants = currentMessage.variants ?? [];
      const targetVariant = variants.find((variant) => variant.id === variantId);
      if (!targetVariant) return;

      const updatedMessage: StoredMessage = {
        ...currentMessage,
        content: targetVariant.content,
        usage: targetVariant.usage ?? currentMessage.usage,
        reasoning: targetVariant.reasoning,
        selectedVariantId: targetVariant.id,
      };

      const updatedMessages = state.messages.map((msg) =>
        msg.id === messageId ? updatedMessage : msg,
      );
      dispatch({ type: "SET_MESSAGES", payload: updatedMessages });

      const updatedSession: Session = {
        ...state.session,
        messages: updatedMessages,
        updatedAt: Date.now(),
      } as Session;
      dispatch({ type: "SET_SESSION", payload: updatedSession });

      if (state.messageAction?.message.id === messageId) {
        dispatch({
          type: "SET_MESSAGE_ACTION",
          payload: { message: updatedMessage, mode: state.messageAction.mode },
        });
      }

      try {
        sessionOperationRef.current = true;
        await safeSaveSession(updatedSession);
        lastKnownSessionTimestampRef.current = updatedSession.updatedAt;
      } catch (err) {
        console.error("ChatController: failed to persist variant selection", err);
      } finally {
        sessionOperationRef.current = false;
      }
    },
    [state.messageAction, state.messages, state.regeneratingMessageId, state.session],
  );

  const handleVariantSwipe = useCallback(
    async (messageId: string, direction: "prev" | "next") => {
      if (!state.session || state.regeneratingMessageId) return;

      const currentMessage = state.messages.find((msg) => msg.id === messageId);
      if (!currentMessage) return;

      if (isStartingSceneMessage(currentMessage)) {
        if (!state.character || !state.session?.selectedSceneId) return;

        const currentSceneIndex = state.character.scenes.findIndex(
          (s) => s.id === state.session!.selectedSceneId,
        );
        if (currentSceneIndex === -1) return;

        const nextSceneIndex = direction === "next" ? currentSceneIndex + 1 : currentSceneIndex - 1;
        if (nextSceneIndex < 0 || nextSceneIndex >= state.character.scenes.length) return;

        const nextScene = state.character.scenes[nextSceneIndex];

        // Get the scene content (variant or original)
        const sceneContent = nextScene.selectedVariantId
          ? (nextScene.variants?.find((v) => v.id === nextScene.selectedVariantId)?.content ??
            nextScene.content)
          : nextScene.content;

        const updatedMessage: StoredMessage = {
          ...currentMessage,
          content: sceneContent,
        };

        const updatedMessages = state.messages.map((msg) =>
          msg.id === messageId ? updatedMessage : msg,
        );

        const updatedSession: Session = {
          ...state.session,
          selectedSceneId: nextScene.id,
          messages: updatedMessages,
          updatedAt: Date.now(),
        } as Session;

        dispatch({ type: "SET_SESSION", payload: updatedSession });
        dispatch({ type: "SET_MESSAGES", payload: updatedMessages });

        try {
          sessionOperationRef.current = true;
          await safeSaveSession(updatedSession);
          lastKnownSessionTimestampRef.current = updatedSession.updatedAt;
        } catch (err) {
          console.error("ChatController: failed to persist scene switch", err);
        } finally {
          sessionOperationRef.current = false;
        }

        return;
      }

      // Regular message variant swipe logic (only for assistant messages)
      if (currentMessage.role !== "assistant") return;
      if (
        state.messages.length === 0 ||
        state.messages[state.messages.length - 1]?.id !== messageId
      )
        return;
      const variants = currentMessage.variants ?? [];
      if (variants.length <= 1) return;

      const variantState = getVariantState(currentMessage);
      const currentIndex =
        variantState.selectedIndex >= 0 ? variantState.selectedIndex : variants.length - 1;
      const nextIndex = direction === "next" ? currentIndex + 1 : currentIndex - 1;
      if (nextIndex < 0 || nextIndex >= variants.length) return;
      const nextVariant = variants[nextIndex];
      await applyVariantSelection(messageId, nextVariant.id);
    },
    [
      applyVariantSelection,
      getVariantState,
      state.character,
      state.messages,
      state.regeneratingMessageId,
      state.session,
    ],
  );

  const handleVariantDrag = useCallback(
    async (messageId: string, offsetX: number) => {
      if (offsetX > 60) {
        await handleVariantSwipe(messageId, "prev");
      } else if (offsetX < -60) {
        await handleVariantSwipe(messageId, "next");
      }
    },
    [handleVariantSwipe],
  );

  const { handleSend, handleContinue, handleRegenerate } = useChatStreamingController({
    state,
    dispatch,
    messagesRef,
    hasMoreMessagesBeforeRef,
    runInChatImageGeneration,
    reloadSessionStateFromStorage,
    triggerTypingHaptic,
    isStartingSceneMessage,
  });

  const handleAbort = useCallback(async () => {
    if (!state.activeRequestId || !state.session) return;

    try {
      await abortMessage(state.activeRequestId);
      log.info("aborted request", state.activeRequestId);

      const messagesWithoutPlaceholders = messagesRef.current
        .map((msg) => {
          if (msg.id.startsWith("placeholder-")) {
            if (msg.content.trim().length > 0) {
              return {
                ...msg,
                id: crypto.randomUUID(),
              };
            }
            return null;
          }
          return msg;
        })
        .filter((msg): msg is StoredMessage => msg !== null);

      const updatedSession: Session = {
        ...state.session,
        messages: messagesWithoutPlaceholders,
        updatedAt: Date.now(),
      };

      console.log(
        "ChatController: saving session after abort with message IDs:",
        messagesWithoutPlaceholders.map((m) => ({
          id: m.id,
          role: m.role,
          contentLength: m.content.length,
        })),
      );

      try {
        sessionOperationRef.current = true;
        await safeSaveSession(updatedSession);
        lastKnownSessionTimestampRef.current = updatedSession.updatedAt;
        messagesRef.current = messagesWithoutPlaceholders;
        dispatch({
          type: "BATCH",
          actions: [
            { type: "SET_SESSION", payload: updatedSession },
            { type: "SET_MESSAGES", payload: messagesWithoutPlaceholders },
          ],
        });
        log.info("successfully saved session after abort");
      } catch (saveErr) {
        log.error("failed to save incomplete messages after abort", saveErr);
        messagesRef.current = messagesWithoutPlaceholders;
        dispatch({ type: "SET_MESSAGES", payload: messagesWithoutPlaceholders });
      } finally {
        sessionOperationRef.current = false;
      }

      dispatch({
        type: "BATCH",
        actions: [
          { type: "SET_SENDING", payload: false },
          { type: "SET_ACTIVE_REQUEST_ID", payload: null },
        ],
      });
    } catch (err) {
      log.error("abort failed", err);
      try {
        const messagesWithoutPlaceholders = state.messages
          .map((msg) => {
            if (msg.id.startsWith("placeholder-")) {
              if (msg.content.trim().length > 0) {
                return {
                  ...msg,
                  id: crypto.randomUUID(),
                };
              }
              return null;
            }
            return msg;
          })
          .filter((msg): msg is StoredMessage => msg !== null);

        const updatedSession: Session = {
          ...state.session!,
          messages: messagesWithoutPlaceholders,
          updatedAt: Date.now(),
        };
        sessionOperationRef.current = true;
        await safeSaveSession(updatedSession);
        lastKnownSessionTimestampRef.current = updatedSession.updatedAt;
        dispatch({
          type: "BATCH",
          actions: [
            { type: "SET_SESSION", payload: updatedSession },
            { type: "SET_MESSAGES", payload: messagesWithoutPlaceholders },
          ],
        });
      } catch (saveErr) {
        log.error("failed to save after abort error", saveErr);
        // Even if everything fails, try to clean up placeholders from UI
        const cleaned = state.messages.filter(
          (msg) => !msg.id.startsWith("placeholder-") || msg.content.trim().length > 0,
        );
        dispatch({ type: "SET_MESSAGES", payload: cleaned });
      } finally {
        sessionOperationRef.current = false;
      }

      dispatch({
        type: "BATCH",
        actions: [
          { type: "SET_SENDING", payload: false },
          { type: "SET_ACTIVE_REQUEST_ID", payload: null },
        ],
      });
    }
  }, [state.activeRequestId, state.session]);

  const handleSaveEdit = useCallback(async () => {
    if (!state.session || !state.messageAction) return;
    const updatedContent = state.editDraft.trim();
    if (!updatedContent) {
      dispatch({ type: "SET_ACTION_ERROR", payload: "Message cannot be empty" });
      return;
    }
    dispatch({
      type: "BATCH",
      actions: [
        { type: "SET_ACTION_BUSY", payload: true },
        { type: "SET_ACTION_ERROR", payload: null },
        { type: "SET_ACTION_STATUS", payload: null },
      ],
    });
    try {
      const editedMessageId = state.messageAction.message.id;
      const editedMessageIndex = messagesRef.current.findIndex((msg) => msg.id === editedMessageId);
      if (editedMessageIndex === -1) {
        throw new Error("Message not found");
      }

      const messagesAfter = messagesRef.current.slice(editedMessageIndex + 1);
      const hasPinnedAfter = messagesAfter.some((msg) => msg.isPinned);
      if (hasPinnedAfter) {
        throw new Error(
          "Cannot edit this message while pinned messages exist after it. Unpin them first.",
        );
      }

      if (messagesAfter.length > 0) {
        await deleteMessagesAfter(state.session.id, editedMessageId);
      }

      const updatedMessages = messagesRef.current.slice(0, editedMessageIndex + 1).map((msg) =>
        msg.id === editedMessageId
          ? {
              ...msg,
              content: updatedContent,
              variants: (msg.variants ?? []).map((variant) =>
                variant.id === (msg.selectedVariantId ?? variant.id)
                  ? { ...variant, content: updatedContent }
                  : variant,
              ),
            }
          : msg,
      );
      const updatedSession: Session = {
        ...state.session,
        messages: updatedMessages,
        updatedAt: Date.now(),
      };
      sessionOperationRef.current = true;
      await safeSaveSession(updatedSession);
      lastKnownSessionTimestampRef.current = updatedSession.updatedAt;
      messagesRef.current = updatedMessages;
      dispatch({ type: "SET_SESSION", payload: updatedSession });
      dispatch({ type: "SET_MESSAGES", payload: updatedMessages });
      resetMessageActions();
    } catch (err) {
      dispatch({
        type: "SET_ACTION_ERROR",
        payload: err instanceof Error ? err.message : String(err),
      });
    } finally {
      sessionOperationRef.current = false;
      dispatch({ type: "SET_ACTION_BUSY", payload: false });
    }
  }, [state.editDraft, state.messageAction, resetMessageActions, state.session]);

  const handleDeleteMessage = useCallback(
    async (message: StoredMessage) => {
      if (!state.session) return;

      if (message.isPinned) {
        dispatch({
          type: "SET_ACTION_ERROR",
          payload: "Cannot delete pinned message. Unpin it first.",
        });
        return;
      }

      const confirmed = await confirmBottomMenu({
        title: "Delete message?",
        message: "Are you sure you want to delete this message?",
        confirmLabel: "Delete",
        destructive: true,
      });
      if (!confirmed) return;
      dispatch({ type: "SET_ACTION_BUSY", payload: true });
      dispatch({ type: "SET_ACTION_ERROR", payload: null });
      dispatch({ type: "SET_ACTION_STATUS", payload: null });
      try {
        await deleteMessage(state.session.id, message.id);
        const updatedMessages = messagesRef.current.filter((msg) => msg.id !== message.id);
        messagesRef.current = updatedMessages;
        dispatch({
          type: "SET_SESSION",
          payload: { ...state.session, messages: updatedMessages, updatedAt: Date.now() },
        });
        dispatch({ type: "SET_MESSAGES", payload: updatedMessages });
        resetMessageActions();
      } catch (err) {
        dispatch({
          type: "SET_ACTION_ERROR",
          payload: err instanceof Error ? err.message : String(err),
        });
      } finally {
        dispatch({ type: "SET_ACTION_BUSY", payload: false });
      }
    },
    [resetMessageActions, state.session],
  );

  const handleRewindToMessage = useCallback(
    async (message: StoredMessage) => {
      if (!state.session) return;

      const messageIndex = messagesRef.current.findIndex((msg) => msg.id === message.id);
      if (messageIndex === -1) {
        dispatch({ type: "SET_ACTION_ERROR", payload: "Message not found" });
        return;
      }

      const messagesAfter = messagesRef.current.slice(messageIndex + 1);
      const hasPinnedAfter = messagesAfter.some((msg) => msg.isPinned);

      if (hasPinnedAfter) {
        dispatch({
          type: "SET_ACTION_ERROR",
          payload: "Cannot rewind: there are pinned messages after this point. Unpin them first.",
        });
        return;
      }

      const confirmed = await confirmBottomMenu({
        title: "Rewind conversation?",
        message:
          "Rewind conversation to this message? All messages after this point will be removed.",
        confirmLabel: "Rewind",
        destructive: true,
      });
      if (!confirmed) return;

      dispatch({ type: "SET_ACTION_BUSY", payload: true });
      dispatch({ type: "SET_ACTION_ERROR", payload: null });
      dispatch({ type: "SET_ACTION_STATUS", payload: null });

      try {
        await deleteMessagesAfter(state.session.id, message.id);
        const updatedMessages = messagesRef.current.slice(0, messageIndex + 1);
        messagesRef.current = updatedMessages;
        dispatch({
          type: "SET_SESSION",
          payload: { ...state.session, messages: updatedMessages, updatedAt: Date.now() },
        });
        dispatch({
          type: "REWIND_TO_MESSAGE",
          payload: { messageId: message.id, messages: updatedMessages },
        });
        resetMessageActions();
      } catch (err) {
        dispatch({
          type: "SET_ACTION_ERROR",
          payload: err instanceof Error ? err.message : String(err),
        });
      } finally {
        dispatch({ type: "SET_ACTION_BUSY", payload: false });
      }
    },
    [resetMessageActions, state.session],
  );

  const handleTogglePin = useCallback(
    async (message: StoredMessage) => {
      if (!state.session) return;

      dispatch({ type: "SET_ACTION_BUSY", payload: true });
      dispatch({ type: "SET_ACTION_ERROR", payload: null });
      dispatch({ type: "SET_ACTION_STATUS", payload: null });

      try {
        const nextPinned = await toggleMessagePin(state.session.id, message.id);

        if (nextPinned !== null) {
          const updatedMessages = messagesRef.current.map((m) =>
            m.id === message.id ? { ...m, isPinned: nextPinned } : m,
          );
          messagesRef.current = updatedMessages;
          dispatch({
            type: "SET_SESSION",
            payload: { ...state.session, messages: updatedMessages, updatedAt: Date.now() },
          });
          dispatch({ type: "SET_MESSAGES", payload: updatedMessages });
          dispatch({
            type: "SET_ACTION_STATUS",
            payload: nextPinned ? "Message pinned" : "Message unpinned",
          });
          setTimeout(() => {
            resetMessageActions();
          }, 1000);
        } else {
          dispatch({ type: "SET_ACTION_ERROR", payload: "Failed to toggle pin" });
        }
      } catch (err) {
        dispatch({
          type: "SET_ACTION_ERROR",
          payload: err instanceof Error ? err.message : String(err),
        });
      } finally {
        dispatch({ type: "SET_ACTION_BUSY", payload: false });
      }
    },
    [resetMessageActions, state.session],
  );

  const handleBranchFromMessage = useCallback(
    async (message: StoredMessage): Promise<string | null> => {
      if (!state.session) return null;

      dispatch({ type: "SET_ACTION_BUSY", payload: true });
      dispatch({ type: "SET_ACTION_ERROR", payload: null });
      dispatch({ type: "SET_ACTION_STATUS", payload: null });

      try {
        const fullSession = await getSession(state.session.id);
        if (!fullSession) {
          dispatch({
            type: "SET_ACTION_ERROR",
            payload: "Failed to load full session for branching",
          });
          return null;
        }

        const messageIndex = fullSession.messages.findIndex((msg) => msg.id === message.id);
        if (messageIndex === -1) {
          dispatch({ type: "SET_ACTION_ERROR", payload: "Message not found" });
          return null;
        }

        const messageCount = messageIndex + 1;
        const confirmed = await confirmBottomMenu({
          title: "Create chat branch?",
          message: `Create a new chat branch from this point? The new chat will contain ${messageCount} message${messageCount > 1 ? "s" : ""}.`,
          confirmLabel: "Create",
        });
        if (!confirmed) {
          dispatch({ type: "SET_ACTION_BUSY", payload: false });
          return null;
        }

        const branchedSession = await createBranchedSession(fullSession, message.id);

        dispatch({ type: "SET_ACTION_STATUS", payload: "Chat branch created! Redirecting..." });

        // Return the new session ID so the caller can navigate to it
        setTimeout(() => {
          resetMessageActions();
        }, 500);

        return branchedSession.id;
      } catch (err) {
        dispatch({
          type: "SET_ACTION_ERROR",
          payload: err instanceof Error ? err.message : String(err),
        });
        return null;
      } finally {
        dispatch({ type: "SET_ACTION_BUSY", payload: false });
      }
    },
    [resetMessageActions, state.session],
  );

  const handleBranchToCharacter = useCallback(
    async (
      message: StoredMessage,
      targetCharacterId: string,
    ): Promise<{ sessionId: string; characterId: string } | null> => {
      if (!state.session) return null;

      dispatch({ type: "SET_ACTION_BUSY", payload: true });
      dispatch({ type: "SET_ACTION_ERROR", payload: null });
      dispatch({ type: "SET_ACTION_STATUS", payload: null });

      try {
        const fullSession = await getSession(state.session.id);
        if (!fullSession) {
          dispatch({
            type: "SET_ACTION_ERROR",
            payload: "Failed to load full session for branching",
          });
          return null;
        }

        const messageIndex = fullSession.messages.findIndex((msg) => msg.id === message.id);
        if (messageIndex === -1) {
          dispatch({ type: "SET_ACTION_ERROR", payload: "Message not found" });
          return null;
        }

        const branchedSession = await createBranchedSessionToCharacter(
          fullSession,
          message.id,
          targetCharacterId,
        );

        dispatch({ type: "SET_ACTION_STATUS", payload: "Chat branch created! Redirecting..." });

        setTimeout(() => {
          resetMessageActions();
        }, 500);

        return { sessionId: branchedSession.id, characterId: targetCharacterId };
      } catch (err) {
        dispatch({
          type: "SET_ACTION_ERROR",
          payload: err instanceof Error ? err.message : String(err),
        });
        return null;
      } finally {
        dispatch({ type: "SET_ACTION_BUSY", payload: false });
      }
    },
    [resetMessageActions, state.session],
  );

  useEffect(() => {
    return () => {
      if (longPressTimerRef.current !== null) {
        window.clearTimeout(longPressTimerRef.current);
      }
    };
  }, []);

  return {
    // State
    character: state.character,
    persona: state.persona,
    session: state.session,
    messages: state.messages,
    draft: state.draft,
    loading: state.loading,
    sending: state.sending,
    error: state.error,
    messageAction: state.messageAction,
    actionError: state.actionError,
    actionStatus: state.actionStatus,
    actionBusy: state.actionBusy,
    editDraft: state.editDraft,
    heldMessageId: state.heldMessageId,
    regeneratingMessageId: state.regeneratingMessageId,
    activeRequestId: state.activeRequestId,
    pendingAttachments: state.pendingAttachments,
    streamingReasoning: state.streamingReasoning,
    hasMoreMessagesBefore: hasMoreMessagesBeforeRef.current,

    // Setters
    setDraft: useCallback((value: string) => dispatch({ type: "SET_DRAFT", payload: value }), []),
    setError: useCallback(
      (value: string | null) => dispatch({ type: "SET_ERROR", payload: value }),
      [],
    ),
    setMessageAction: useCallback(
      (value: MessageActionState | null) =>
        dispatch({ type: "SET_MESSAGE_ACTION", payload: value }),
      [],
    ),
    setActionError: useCallback(
      (value: string | null) => dispatch({ type: "SET_ACTION_ERROR", payload: value }),
      [],
    ),
    setActionStatus: useCallback(
      (value: string | null) => dispatch({ type: "SET_ACTION_STATUS", payload: value }),
      [],
    ),
    setActionBusy: useCallback(
      (value: boolean) => dispatch({ type: "SET_ACTION_BUSY", payload: value }),
      [],
    ),
    setEditDraft: useCallback(
      (value: string) => dispatch({ type: "SET_EDIT_DRAFT", payload: value }),
      [],
    ),
    setHeldMessageId: useCallback(
      (value: string | null) => dispatch({ type: "SET_HELD_MESSAGE_ID", payload: value }),
      [],
    ),
    setPendingAttachments: useCallback(
      (attachments: ImageAttachment[]) =>
        dispatch({ type: "SET_PENDING_ATTACHMENTS", payload: attachments }),
      [],
    ),
    addPendingAttachment: useCallback(
      (attachment: ImageAttachment) =>
        dispatch({ type: "ADD_PENDING_ATTACHMENT", payload: attachment }),
      [],
    ),
    removePendingAttachment: useCallback(
      (attachmentId: string) =>
        dispatch({ type: "REMOVE_PENDING_ATTACHMENT", payload: attachmentId }),
      [],
    ),
    clearPendingAttachments: useCallback(() => dispatch({ type: "CLEAR_PENDING_ATTACHMENTS" }), []),

    // Actions
    handleSend,
    handleContinue,
    handleRegenerate,
    handleAbort,
    loadOlderMessages,
    ensureMessageLoaded,
    getVariantState,
    applyVariantSelection,
    handleVariantSwipe,
    handleVariantDrag,
    handleSaveEdit,
    handleDeleteMessage,
    handleRewindToMessage,
    handleBranchFromMessage,
    handleBranchToCharacter,
    handleTogglePin,
    resetMessageActions,
    initializeLongPressTimer: (timer) => {
      if (timer === null) {
        clearLongPress();
      } else {
        longPressTimerRef.current = timer;
      }
    },
    isStartingSceneMessage: useCallback((message: StoredMessage) => {
      return isStartingSceneMessage(message);
    }, []),
  };
}
