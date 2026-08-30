import {
  createClipboard,
  createHostClipboard,
  createRendererClipboardAdapter,
  decodePasteBytes,
  type BoxRenderable,
  type ScrollBoxRenderable,
  type TextareaRenderable,
} from "@opentui/core";
import {
  extend,
  useKeyboard,
  usePaste,
  useRenderer,
  useSelectionHandler,
  useTerminalDimensions,
} from "@opentui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { SpinnerRenderable } from "opentui-spinner";
extend({ spinner: SpinnerRenderable });
import { IPCClient, type IPCEvent } from "../../common/ipc-client";
import {
  checkForUpdate,
  GitHubAuthenticationError,
} from "../../common/updater";
import type {
  Conversation,
  ConversationItem,
  Dialog,
  FileTransfer,
  Group,
  GroupMember,
  ImageProtocol,
  Message,
  Peer,
  ReplyTarget,
  TypingPeer,
  UnreadMessageState,
} from "./types";
import {
  composerLimitColor,
  DEFAULT_STATUS,
  getComposerHeight,
  isImageFile,
  MIN_COMPOSER_HEIGHT,
  peerPresence,
  sortPeersByInteraction,
  UNREAD_MESSAGE_FADE_MS,
} from "./utils";
import { Sidebar } from "./components/Sidebar";
import { ConversationPanel } from "./components/ConversationPanel";
import { DialogPanel } from "./components/DialogPanel";
import {
  notify,
  type NotificationDelivery,
  type NotificationPreferences,
} from "./notifications";
import { useChatActions } from "./useChatActions";
import { StartupSplash, IS_RELEASE_BUILD, APP_RELEASE_VERSION, MIN_SPLASH_PHASE_MS, MIN_SPLASH_DURATION_MS } from "./SplashScreen";

declare const APP_VERSION: string;

function detectImageMime(bytes: Uint8Array): string | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return "image/png";
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return "image/jpeg";
  if (
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38
  )
    return "image/gif";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp";
  return undefined;
}

export function ChatApp() {
  const renderer = useRenderer();
  const { width, height } = useTerminalDimensions();
  const [ipc] = useState(() => new IPCClient());
  const [tuiClientId] = useState(() => crypto.randomUUID());
  const [peers, setPeers] = useState<Peer[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [groupMembers, setGroupMembers] = useState<
    Record<string, GroupMember[]>
  >({});
  const [identity, setIdentity] = useState<{
    peer_id: string;
    display_name: string;
  }>();
  const [selection, setSelection] = useState<Conversation>();
  const [messages, setMessages] = useState<Message[]>([]);
  const [selectedReplyTarget, setSelectedReplyTarget] = useState<ReplyTarget>();
  const [replyTo, setReplyTo] = useState<ReplyTarget>();
  const [deleteConfirmation, setDeleteConfirmation] = useState<ReplyTarget>();
  const [unreadMessages, setUnreadMessages] = useState<
    Record<string, UnreadMessageState>
  >({});
  const [unreadNow, setUnreadNow] = useState(() => Date.now());
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [draftLength, setDraftLength] = useState(0);
  const [composerHeight, setComposerHeight] = useState(MIN_COMPOSER_HEIGHT);
  const [isSending, setIsSending] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [scrollFocused, setScrollFocused] = useState(false);
  const [deliveredMessageIds, setDeliveredMessageIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [status, setStatus] = useState("Connecting to backend...");
  const [startupMessage, setStartupMessage] = useState("Preparing terminal graphics...");
  const [rendererReady, setRendererReady] = useState(false);
  const [appReady, setAppReady] = useState(false);
  const [splashDurationMs, setSplashDurationMs] = useState(MIN_SPLASH_DURATION_MS);
  const [splashPhaseMs, setSplashPhaseMs] = useState(MIN_SPLASH_PHASE_MS);
  const startupPhase = useRef({
    message: "Preparing terminal graphics...",
    startedAt: Date.now(),
  });
  const splashStartedAt = useRef(Date.now());
  const [copyToast, setCopyToast] = useState(false);
  const [mutedPeers, setMutedPeers] = useState<Record<string, number>>({});
  const [notificationPreferences, setNotificationPreferences] =
    useState<NotificationPreferences | null>(null);
  const [notificationTestDelivery, setNotificationTestDelivery] =
    useState<Exclude<NotificationDelivery, "disabled"> | null>(null);
  const [blinkOn, setBlinkOn] = useState(true);
  const [flashingEnabled, setFlashingEnabled] = useState(true);
  const [imageProtocol, setImageProtocol] = useState<ImageProtocol>("auto");
  const [controlStatus, setControlStatus] = useState<{
    connected: boolean;
    reconnect_attempts: number;
    control_url?: string | null;
  }>({ connected: false, reconnect_attempts: 0 });
  const [debugInfo, setDebugInfo] = useState<
    import("./types").DebugInfo | null
  >(null);
  const [fileTransfers, setFileTransfers] = useState<FileTransfer[]>([]);
  const [typingPeers, setTypingPeers] = useState<
    Record<string, Record<string, TypingPeer>>
  >({});
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [dialogDraft, setDialogDraft] = useState("");
  const [dialogError, setDialogError] = useState("");
  const [dialogBusy, setDialogBusy] = useState(false);
  const scrollboxRef = useRef<ScrollBoxRenderable>(null);
  const composerRef = useRef<TextareaRenderable>(null);
  const backendDisconnected = useRef(false);
  const statusReset = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const copyToastReset = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const clipboard = useRef<ReturnType<typeof createClipboard> | null>(null);
  const dialogAction = useRef(0);
  const dialogBusyRef = useRef(false);
  const filePickerOpen = useRef(false);
  const deleteConfirmationTimer = useRef<
    ReturnType<typeof setTimeout> | undefined
  >(undefined);
  const typingStartTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const typingIdleTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined,
  );
  const typingHeartbeat = useRef<ReturnType<typeof setInterval> | undefined>(
    undefined,
  );
  const pendingTypingConversation = useRef<Conversation | undefined>(undefined);
  const outgoingTypingConversation = useRef<Conversation | undefined>(
    undefined,
  );
  const selectedPeerId = selection?.kind === "peer" ? selection.id : undefined;
  const selectedGroupId =
    selection?.kind === "group" ? selection.id : undefined;
  const selectionKey = selection
    ? `${selection.kind}:${selection.id}`
    : undefined;

  async function showStartupPhase(message: string) {
    if (startupPhase.current.message === message) return;
    const elapsed = Date.now() - startupPhase.current.startedAt;
    if (elapsed < splashPhaseMs)
      await Bun.sleep(splashPhaseMs - elapsed);
    startupPhase.current = { message, startedAt: Date.now() };
    setStartupMessage(message);
  }

  function rememberUnreadMessage(
    conversationKey: string,
    messageId: string | undefined,
    receivedAt = Date.now(),
  ) {
    if (!messageId) return;
    setUnreadMessages((current) =>
      current[messageId]
        ? current
        : { ...current, [messageId]: { conversationKey, receivedAt } },
    );
  }

  function rememberUnreadHistory(
    conversationKey: string,
    history: Message[],
    unreadCount: number,
  ) {
    if (!identity?.peer_id || unreadCount <= 0) return;
    const incoming = history.filter(
      (message) => message.sender_id !== identity.peer_id,
    );
    const unread = incoming.slice(Math.max(0, incoming.length - unreadCount));
    setUnreadMessages((current) => {
      let changed = false;
      const next = { ...current };
      for (const message of unread) {
        if (next[message.message_id]) continue;
        const receivedAt =
          typeof message.received_at === "number" &&
          Number.isFinite(message.received_at)
            ? message.received_at * 1000
            : Date.now();
        next[message.message_id] = { conversationKey, receivedAt };
        changed = true;
      }
      return changed ? next : current;
    });
  }

  function markUnreadMessageVisible(messageId: string) {
    setUnreadMessages((current) => {
      const message = current[messageId];
      if (!message || message.visibleAt !== undefined) return current;
      return { ...current, [messageId]: { ...message, visibleAt: Date.now() } };
    });
  }

  function updatePeerInteraction(
    peerId: string | undefined,
    timestamp = Date.now() / 1000,
  ) {
    if (!peerId) return;
    setPeers((current) =>
      sortPeersByInteraction(
        current.map((peer) =>
          peer.peer_id === peerId
            ? { ...peer, last_interaction: timestamp }
            : peer,
        ),
      ),
    );
  }

  function sendTyping(conversation: Conversation, isTyping: boolean) {
    const target =
      conversation.kind === "peer"
        ? { recipient_id: conversation.id }
        : { group_id: conversation.id };
    void ipc
      .send("typing", {
        client_id: tuiClientId,
        ...target,
        is_typing: isTyping,
      })
      .catch(() => {});
  }

  function stopOutgoingTyping() {
    if (typingStartTimer.current) clearTimeout(typingStartTimer.current);
    if (typingIdleTimer.current) clearTimeout(typingIdleTimer.current);
    if (typingHeartbeat.current) clearInterval(typingHeartbeat.current);
    typingStartTimer.current = undefined;
    typingIdleTimer.current = undefined;
    typingHeartbeat.current = undefined;
    pendingTypingConversation.current = undefined;
    const conversation = outgoingTypingConversation.current;
    outgoingTypingConversation.current = undefined;
    if (conversation) sendTyping(conversation, false);
  }

  function handleComposerChange(content: string) {
    if (selectionKey)
      setDrafts((current) => ({ ...current, [selectionKey]: content }));
    if (!selection || !content) {
      stopOutgoingTyping();
      return;
    }
    const conversation = selection;
    const active = outgoingTypingConversation.current;
    if (
      active &&
      (active.kind !== conversation.kind || active.id !== conversation.id)
    )
      stopOutgoingTyping();
    pendingTypingConversation.current = conversation;
    if (!outgoingTypingConversation.current && !typingStartTimer.current) {
      typingStartTimer.current = setTimeout(() => {
        typingStartTimer.current = undefined;
        const pending = pendingTypingConversation.current;
        if (!pending) return;
        outgoingTypingConversation.current = pending;
        sendTyping(pending, true);
        typingHeartbeat.current = setInterval(() => {
          const current = outgoingTypingConversation.current;
          if (current) sendTyping(current, true);
        }, 2500);
      }, 300);
    }
    if (typingIdleTimer.current) clearTimeout(typingIdleTimer.current);
    typingIdleTimer.current = setTimeout(stopOutgoingTyping, 3000);
  }

  const actions = useChatActions({
    ipc,
    clipboardRef: clipboard,
    renderer,
    backendDisconnectedRef: backendDisconnected,
    peers,
    setPeers,
    groups,
    setGroups,
    groupMembers,
    setGroupMembers,
    identity,
    setIdentity,
    selection,
    setSelection,
    selectedPeerId,
    selectedGroupId,
    messages,
    setMessages,
    drafts,
    setDrafts,
    draftLength,
    setDraftLength,
    composerHeight,
    setComposerHeight,
    isSending,
    setIsSending,
    nameDraft,
    setNameDraft,
    editingName,
    setEditingName,
    scrollFocused,
    setScrollFocused,
    deliveredMessageIds,
    setDeliveredMessageIds,
    status,
    setStatus,
    copyToast,
    setCopyToast,
    mutedPeers,
    setMutedPeers,
    notificationPreferences,
    setNotificationPreferences,
    notificationTestDelivery,
    setNotificationTestDelivery,
    flashingEnabled,
    setFlashingEnabled,
    setImageProtocol,
    controlStatus,
    setControlStatus,
    debugInfo,
    setDebugInfo,
    fileTransfers,
    setFileTransfers,
    dialog,
    setDialog,
    setDialogDraft,
    setDialogError,
    setDialogBusy,
    statusResetRef: statusReset,
    copyToastResetRef: copyToastReset,
    dialogActionRef: dialogAction,
    dialogBusyRef,
    filePickerOpenRef: filePickerOpen,
    composerRef,
    selectionKey,
  });

  useEffect(() => {
    let cancelled = false;
    void Promise.race([renderer.idle(), Bun.sleep(250)])
      .then(() => Bun.sleep(50))
      .then(() => showStartupPhase("Connecting to MeshTalk backend..."))
      .then(() => {
        if (!cancelled) setRendererReady(true);
      })
      .catch(() => {
        if (!cancelled) setRendererReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [renderer]);

  useEffect(() => {
    if (!rendererReady) return;
    let cancelled = false;
    async function connectWithRetry() {
      const deadline = Date.now() + 60_000;
      let attempt = 0;
      while (!cancelled) {
        try {
          await ipc.connect();
          return;
        } catch (error) {
          ipc.close();
          if (Date.now() >= deadline) throw error;
          attempt += 1;
          const delay = Math.min(1_000, 100 * 2 ** Math.min(attempt, 4));
          await showStartupPhase("Waiting for MeshTalk backend...");
          await Bun.sleep(delay);
        }
      }
      throw new Error("MeshTalk startup was cancelled");
    }
    connectWithRetry()
      .then(async () => {
        const response = await ipc.send("identity");
        if (response.error) throw new Error(response.error);
        const nextIdentity = {
          peer_id: response.peer_id as string,
          display_name: response.display_name as string,
        };
        setIdentity(nextIdentity);
        setFlashingEnabled(response.flashing_enabled as boolean);
        setNameDraft(nextIdentity.display_name);
        const presence = await ipc.send("tui_presence", {
          client_id: tuiClientId,
          active: true,
        });
        if (presence.error) throw new Error(presence.error);
        await showStartupPhase("Loading conversations and contacts...");
        await actions.refreshPeers();
        await actions.refreshGroups();
        void actions.refreshFiles();
        const mutedResp = await ipc.send("muted_peers");
        if (!mutedResp.error)
          setMutedPeers(mutedResp.muted_peers as Record<string, number>);
        const notificationResponse = await ipc.send("notifications");
        if (notificationResponse.error)
          throw new Error(notificationResponse.error);
        const preferences = notificationResponse as NotificationPreferences;
        setNotificationPreferences(preferences);
        const control = await ipc.send("control");
        if (control.error) throw new Error(control.error);
        setControlStatus({
          connected: control.connected as boolean,
          reconnect_attempts: control.reconnect_attempts as number,
          control_url: control.url as string | null | undefined,
        });
        const advanced = await ipc.send("advanced_config");
        if (!advanced.error) {
          setImageProtocol(advanced.image_protocol as ImageProtocol);
          if (typeof advanced.splash_duration_ms === "number" && advanced.splash_duration_ms >= 0)
            setSplashDurationMs(advanced.splash_duration_ms);
          if (typeof advanced.splash_phase_ms === "number" && advanced.splash_phase_ms >= 0)
            setSplashPhaseMs(advanced.splash_phase_ms);
        }
        await showStartupPhase("Finalising terminal layout...");
        await Promise.race([renderer.idle(), Bun.sleep(250)]);
        await Bun.sleep(50);
        await Bun.sleep(Math.max(0, splashDurationMs - (Date.now() - splashStartedAt.current)));
        if (!(response.setup_dismissed as boolean)) {
          setDialog({ kind: "rename", firstRun: true });
        } else if (!control.url && !control.setup_dismissed) {
          setDialog({ kind: "control", firstRun: true });
        } else if (!preferences.setup_dismissed) {
          setDialog({ kind: "notification-enable", firstRun: true });
        }
        if (IS_RELEASE_BUILD) {
          void checkForUpdate(APP_RELEASE_VERSION)
            .then((release) => {
              if (
                release &&
                (response.setup_dismissed as boolean) &&
                (control.url || control.setup_dismissed)
              ) {
                actions.showDialog({ kind: "update", release });
              }
            })
            .catch((error) => {
              if (error instanceof GitHubAuthenticationError)
                actions.showDialog({ kind: "update-token" });
            });
        }
        setStatus(DEFAULT_STATUS);
        setAppReady(true);
      })
      .catch((error) => {
        if (!cancelled && !backendDisconnected.current) {
          const message = `Backend error: ${error instanceof Error ? error.message : String(error)}`;
          setStatus(message);
          setStartupMessage(message);
        }
      });
    return () => {
      cancelled = true;
      void ipc
        .send("tui_presence", { client_id: tuiClientId, active: false })
        .finally(() => {
          ipc.close();
        });
    };
  }, [rendererReady, tuiClientId]);

  useEffect(
    () => () => {
      if (statusReset.current) clearTimeout(statusReset.current);
      if (copyToastReset.current) clearTimeout(copyToastReset.current);
    },
    [],
  );

  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      setTypingPeers((current) => {
        let changed = false;
        const next: Record<string, Record<string, TypingPeer>> = {};
        for (const [conversation, peers] of Object.entries(current)) {
          const active = Object.fromEntries(
            Object.entries(peers).filter(([, peer]) => peer.expiresAt > now),
          );
          if (Object.keys(active).length) next[conversation] = active;
          if (Object.keys(active).length !== Object.keys(peers).length)
            changed = true;
        }
        return changed ? next : current;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (
      !Object.values(unreadMessages).some(
        (message) => message.visibleAt !== undefined,
      )
    )
      return;
    const interval = setInterval(() => {
      const now = Date.now();
      setUnreadNow(now);
      setUnreadMessages((current) => {
        let changed = false;
        const next: Record<string, UnreadMessageState> = {};
        for (const [messageId, message] of Object.entries(current)) {
          if (
            message.visibleAt !== undefined &&
            now - message.visibleAt >= UNREAD_MESSAGE_FADE_MS
          ) {
            changed = true;
            continue;
          }
          next[messageId] = message;
        }
        return changed ? next : current;
      });
    }, 100);
    return () => clearInterval(interval);
  }, [unreadMessages]);

  useEffect(() => () => stopOutgoingTyping(), [selectionKey]);

  useEffect(() => {
    setSelectedReplyTarget(undefined);
    setReplyTo(undefined);
    setDeleteConfirmation(undefined);
  }, [selectionKey]);

  useEffect(() => {
    if (deleteConfirmationTimer.current)
      clearTimeout(deleteConfirmationTimer.current);
    if (!deleteConfirmation) {
      deleteConfirmationTimer.current = undefined;
      return;
    }
    deleteConfirmationTimer.current = setTimeout(() => {
      setDeleteConfirmation(undefined);
      actions.showStatus("Message deletion timed out.");
    }, 5_000);
    return () => {
      if (deleteConfirmationTimer.current)
        clearTimeout(deleteConfirmationTimer.current);
      deleteConfirmationTimer.current = undefined;
    };
  }, [deleteConfirmation]);

  useEffect(() => {
    if (dialog || editingName || scrollFocused || isSending)
      stopOutgoingTyping();
  }, [dialog, editingName, scrollFocused, isSending]);

  useEffect(() => {
    const service = createClipboard({
      host: createHostClipboard({ maxReadBytes: 8 * 1024 * 1024 }),
      terminal: createRendererClipboardAdapter(renderer),
    });
    clipboard.current = service;
    return () => {
      clipboard.current = null;
      void service.dispose();
    };
  }, [renderer]);

  useSelectionHandler((selection) => {
    const text = selection.getSelectedText();
    if (!text) return;
    void clipboard.current
      ?.writeText(text, { destination: "all-available", allowRemoteHost: true })
      .then(() => {
        renderer.clearSelection();
        actions.showCopyToast();
      });
  });

  useEffect(() => {
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = ipc.onDisconnect(() => {
      backendDisconnected.current = true;
      setStatus("Backend connection lost. Closing MeshTalk...");
      exitTimer = setTimeout(() => renderer.destroy(), 1500);
    });
    return () => {
      unsubscribe();
      if (exitTimer) clearTimeout(exitTimer);
    };
  }, [ipc, renderer]);

  useEffect(() => {
    let active = true;
    const interval = setInterval(() => {
      void actions.refreshPeers().catch((error) => {
        if (active && !backendDisconnected.current)
          setStatus(`Peer refresh error: ${String(error)}`);
      });
      void actions.refreshGroups().catch((error) => {
        if (active && !backendDisconnected.current)
          setStatus(`Group refresh error: ${String(error)}`);
      });
      void actions.refreshGroupMembers().catch((error) => {
        if (active && !backendDisconnected.current && selectedGroupId)
          setStatus(`Group member refresh error: ${String(error)}`);
      });
      void actions.refreshFiles();
      void ipc
        .send("control")
        .then((control) => {
          if (active && !control.error)
            setControlStatus({
              connected: control.connected as boolean,
              reconnect_attempts: control.reconnect_attempts as number,
              control_url: control.url as string | null | undefined,
            });
        })
        .catch(() => {});
    }, 3000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [ipc, selectedGroupId]);

  useEffect(() => {
    if (!flashingEnabled) return;
    const interval = setInterval(() => setBlinkOn((v) => !v), 600);
    return () => clearInterval(interval);
  }, [flashingEnabled]);

  useEffect(
    () =>
      ipc.onEvent((event: IPCEvent) => {
        if (event.event === "typing") {
          const senderId = event.sender_id as string;
          if (senderId === identity?.peer_id) return;
          const groupId = event.group_id as string | null | undefined;
          const conversation = groupId
            ? `group:${groupId}`
            : `peer:${senderId}`;
          const createdAt = event.created_at as number;
          if (!Number.isFinite(createdAt)) return;
          const isTyping = Boolean(event.is_typing);
          const displayName =
            (event.display_name as string | undefined) ??
            peers.find((peer) => peer.peer_id === senderId)?.display_name ??
            "Someone";
          setTypingPeers((current) => {
            const previous = current[conversation]?.[senderId];
            if (previous && previous.createdAt >= createdAt) return current;
            return {
              ...current,
              [conversation]: {
                ...current[conversation],
                [senderId]: {
                  displayName,
                  createdAt,
                  isTyping,
                  // Retain a stopped event long enough to reject an older UDP start.
                  expiresAt: Date.now() + (isTyping ? 6000 : 30000),
                },
              },
            };
          });
          return;
        }
        if (
          [
            "group_message",
            "group_member_joined",
            "group_member_left",
          ].includes(event.event)
        ) {
          const groupId = event.group_id as string;
          const group = groups.find((item) => item.group_id === groupId);
          const senderId = event.sender_id as string | undefined;
          if (senderId)
            setTypingPeers((current) => {
              const conversation = `group:${groupId}`;
              const { [senderId]: _, ...remaining } =
                current[conversation] ?? {};
              const { [conversation]: __, ...other } = current;
              return Object.keys(remaining).length
                ? { ...other, [conversation]: remaining }
                : other;
            });
          if (event.event === "group_member_left" && event.peer_id)
            setTypingPeers((current) => {
              const conversation = `group:${groupId}`;
              const { [event.peer_id as string]: _, ...remaining } =
                current[conversation] ?? {};
              const { [conversation]: __, ...other } = current;
              return Object.keys(remaining).length
                ? { ...other, [conversation]: remaining }
                : other;
            });
          const sender =
            (event.display_name as string | undefined) ??
            peers.find((peer) => peer.peer_id === senderId)?.display_name ??
            groupMembers[groupId]?.find(
              (member) => (member.peer_id ?? member.member_id) === senderId,
            )?.display_name ??
            "a member";
          if (event.event === "group_message")
            void notify(
              notificationPreferences,
              "messages",
              renderer,
              `New message from ${sender} in ${group?.name ?? "a group"}`,
            );
          if (groupId !== selectedGroupId) {
            if (event.event === "group_message")
              rememberUnreadMessage(
                `group:${groupId}`,
                event.message_id as string | undefined,
              );
            setGroups((current) =>
              current.map((item) =>
                item.group_id === groupId
                  ? { ...item, unread_count: item.unread_count + 1 }
                  : item,
              ),
            );
          } else {
            void ipc
              .send("group_messages", { group_id: groupId })
              .then((response) => {
                if (!response.error)
                  setMessages(response.messages as Message[]);
              })
              .catch(() => {});
          }
          void actions.refreshGroups();
          if (event.event !== "group_message") {
            void ipc
              .send("group_members", { group_id: groupId })
              .then((response) => {
                if (!response.error)
                  setGroupMembers((current) => ({
                    ...current,
                    [groupId]: response.members as GroupMember[],
                  }));
              })
              .catch(() => {});
          }
          return;
        }
        if (event.event === "group_delivered" || event.event === "group_sent") {
          const messageId = event.message_id as string;
          setMessages((current) =>
            current.map((message) => {
              if (message.message_id !== messageId) return message;
              if (Array.isArray(event.deliveries))
                return {
                  ...message,
                  deliveries:
                    event.deliveries as import("./types").GroupDelivery[],
                };
              const recipientId = event.recipient_id as string | undefined;
              if (!recipientId) return message;
              return {
                ...message,
                deliveries: (message.deliveries ?? []).map((delivery) =>
                  delivery.recipient_id === recipientId
                    ? {
                        ...delivery,
                        status:
                          (event.status as string | undefined) ??
                          (event.event === "group_delivered"
                            ? "delivered"
                            : "sent"),
                        updated_at:
                          (event.updated_at as number | undefined) ??
                          Date.now() / 1000,
                      }
                    : delivery,
                ),
              };
            }),
          );
          if (selectedGroupId && selectedGroupId === event.group_id) {
            void ipc
              .send("group_messages", { group_id: selectedGroupId })
              .then((response) => {
                if (!response.error)
                  setMessages(response.messages as Message[]);
              })
              .catch(() => {});
          }
          return;
        }
        if (event.event === "delivered") {
          const messageId = event.message_id as string;
          setDeliveredMessageIds((c) => new Set(c).add(messageId));
          setMessages((current) =>
            current.map((message) =>
              message.message_id === messageId
                ? {
                    ...message,
                    delivered: 1,
                    queued: 0,
                    received_at: Date.now() / 1000,
                  }
                : message,
            ),
          );
          actions.showStatus("Message delivered.");
          return;
        }
        if (event.event === "message_sent") {
          const messageId = event.message_id as string;
          setMessages((current) =>
            current.map((message) =>
              message.message_id === messageId
                ? { ...message, queued: 0 }
                : message,
            ),
          );
          return;
        }
        if (event.event === "message_blocked") {
          const messageId = event.message_id as string;
          const name = (event.display_name as string) ?? "a peer";
          setMessages((current) =>
            current.map((message) =>
              message.message_id === messageId
                ? { ...message, blocked: 1 }
                : message,
            ),
          );
          if (event.removed_friend)
            actions.showStatus(
              `${name} removed you as a friend. You are no longer friends.`,
            );
          else
            actions.showStatus(
              `Message blocked: ${name} hasn't added you as a friend yet.`,
            );
          void actions.refreshPeers();
          return;
        }
        if (event.event === "message_failed") {
          const messageId = event.message_id as string;
          setMessages((current) =>
            current.map((message) =>
              message.message_id === messageId
                ? { ...message, failed: 1, queued: 0 }
                : message,
            ),
          );
          actions.showStatus(
            "Message cancelled because the peer does not support text chat.",
          );
          return;
        }
        if (event.event === "friend_request") {
          const request: import("./types").FriendRequest = {
            request_id: event.request_id as string,
            sender_id: event.sender_id as string,
            sender_name: (event.sender_name as string) ?? "a peer",
            note: (event.note as string | null | undefined) ?? null,
            created_at: event.created_at as number,
            direction: "incoming",
            status: "pending",
          };
          void notify(
            notificationPreferences,
            "friend_requests",
            renderer,
            `Friend request from ${request.sender_name}`,
          );
          if (!dialog) setDialog({ kind: "friend-request-incoming", request });
          else
            actions.showStatus(
              `Friend request from ${request.sender_name}. Open Commands > Friends to respond.`,
            );
          void actions.refreshPeers();
          return;
        }
        if (event.event === "friend_response") {
          const name = (event.display_name as string) ?? "a peer";
          actions.showStatus(
            event.accepted
              ? `${name} accepted your friend request. You can now chat.`
              : `${name} declined your friend request.`,
          );
          void actions.refreshPeers();
          return;
        }
        if (event.event === "friend_cancelled") {
          const name = (event.display_name as string) ?? "a peer";
          actions.showStatus(`${name} cancelled their friend request.`);
          void actions.refreshPeers();
          return;
        }
        if (event.event === "peer_capability_gap") {
          void actions.refreshPeers();
          return;
        }
        if (event.event === "file_offer") {
          const filename = event.filename as string;
          if (!event.group_id)
            updatePeerInteraction(event.sender_id as string | undefined);
          const sender =
            peers.find((p) => p.peer_id === event.sender_id)?.display_name ??
            String(event.sender_id).slice(0, 8);
          actions.showStatus(
            `Incoming file: ${filename} (${event.file_size} bytes) from ${sender}`,
          );
          void notify(
            notificationPreferences,
            "file_offers",
            renderer,
            `Incoming file ${filename} from ${sender}`,
          );
          void ipc
            .send("files")
            .then((res) => {
              if (!res.error) setFileTransfers(res.files as FileTransfer[]);
            })
            .catch(() => {});
          return;
        }
        if (event.event === "file_progress") {
          setFileTransfers((cur) =>
            cur.map((f) =>
              f.file_id === event.file_id
                ? {
                    ...f,
                    received_chunks:
                      (event.received as number) ?? f.received_chunks,
                  }
                : f,
            ),
          );
          return;
        }
        if (event.event === "file_completed") {
          const filename = event.filename as string;
          const fpath = event.file_path as string;
          const fileId = event.file_id as string;
          if (!event.group_id)
            updatePeerInteraction(event.sender_id as string | undefined);
          actions.showStatus(`File received: ${filename} -> ${fpath}`);
          void notify(
            notificationPreferences,
            "file_completed",
            renderer,
            `File received: ${filename}`,
          );
          setFileTransfers((current) =>
            current.map((file) =>
              file.file_id === fileId
                ? {
                    ...file,
                    status: "completed",
                    file_path: fpath,
                    completed_at: Date.now() / 1000,
                  }
                : file,
            ),
          );
          void ipc
            .send("files")
            .then((res) => {
              if (!res.error) setFileTransfers(res.files as FileTransfer[]);
            })
            .catch(() => {});
          return;
        }
        if (
          event.event === "file_sent" ||
          event.event === "file_delivered" ||
          event.event === "file_queued"
        ) {
          const name = (event.file_id as string)?.slice(0, 8) ?? "file";
          if (!event.group_id)
            updatePeerInteraction(event.recipient_id as string | undefined);
          if (event.event === "file_sent")
            actions.showStatus(`File ${name} sent.`);
          else if (event.event === "file_delivered")
            actions.showStatus(`File ${name} delivered.`);
          else actions.showStatus(`File ${name} queued for offline peer.`);
          void ipc
            .send("files")
            .then((res) => {
              if (!res.error) setFileTransfers(res.files as FileTransfer[]);
            })
            .catch(() => {});
          return;
        }
        if (event.event !== "message") {
          if (event.event === "peer_update") {
            void actions.refreshPeers();
          }
          return;
        }
        const senderId = event.sender_id as string;
        setTypingPeers((current) => {
          const conversation = `peer:${senderId}`;
          const { [senderId]: _, ...remaining } = current[conversation] ?? {};
          const { [conversation]: __, ...other } = current;
          return Object.keys(remaining).length
            ? { ...other, [conversation]: remaining }
            : other;
        });
        const sender =
          peers.find((peer) => peer.peer_id === senderId)?.display_name ??
          "a peer";
        const mutedUntil = mutedPeers[senderId];
        const isMuted =
          mutedUntil === undefined
            ? false
            : mutedUntil <= 0 || Date.now() / 1000 < mutedUntil;
        if (!isMuted)
          void notify(
            notificationPreferences,
            "messages",
            renderer,
            `New message from ${sender}`,
          );
        updatePeerInteraction(senderId);
        if (senderId !== selectedPeerId) {
          rememberUnreadMessage(
            `peer:${senderId}`,
            event.message_id as string | undefined,
          );
          setPeers((current) =>
            current.map((peer) =>
              peer.peer_id === senderId
                ? { ...peer, unread_count: peer.unread_count + 1 }
                : peer,
            ),
          );
          return;
        }
        setMessages((current) => [
          ...current,
          {
            message_id: event.message_id as string,
            sender_id: senderId,
            recipient_id: "",
            content: event.content as string,
            created_at: event.created_at as number,
            received_at: Date.now() / 1000,
            reply_to_message_id: event.reply_to_message_id as
              string | null | undefined,
          },
        ]);
        void ipc
          .send("messages", { peer_id: senderId })
          .then((response) => {
            if (!response.error) {
              setMessages(response.messages as Message[]);
              void actions.refreshPeers();
            }
          })
          .catch(() => {});
      }),
    [
      ipc,
      mutedPeers,
      peers,
      groups,
      groupMembers,
      renderer,
      selectedPeerId,
      selectedGroupId,
      dialog,
    ],
  );

  useEffect(() => {
    let cancelled = false;
    if (!selection || !selectionKey) {
      setMessages([]);
      setDraftLength(0);
      setComposerHeight(MIN_COMPOSER_HEIGHT);
      return;
    }
    const unreadCount =
      selection.kind === "peer"
        ? (peers.find((peer) => peer.peer_id === selection.id)?.unread_count ??
          0)
        : (groups.find((group) => group.group_id === selection.id)
            ?.unread_count ?? 0);
    setScrollFocused(false);
    setDraftLength(new TextEncoder().encode(drafts[selectionKey] ?? "").length);
    setComposerHeight(MIN_COMPOSER_HEIGHT);
    if (selection.kind === "peer") {
      setPeers((current) =>
        current.map((peer) =>
          peer.peer_id === selection.id ? { ...peer, unread_count: 0 } : peer,
        ),
      );
    } else {
      setGroups((current) =>
        current.map((group) =>
          group.group_id === selection.id
            ? { ...group, unread_count: 0 }
            : group,
        ),
      );
      void ipc
        .send("group_members", { group_id: selection.id })
        .then((response) => {
          if (!cancelled && !response.error)
            setGroupMembers((current) => ({
              ...current,
              [selection.id]: response.members as GroupMember[],
            }));
        })
        .catch(() => {});
    }
    const request =
      selection.kind === "peer"
        ? ipc.send("messages", { peer_id: selection.id })
        : ipc.send("group_messages", { group_id: selection.id });
    request
      .then((response) => {
        if (response.error) throw new Error(response.error);
        if (cancelled) return;
        const history = response.messages as Message[];
        rememberUnreadHistory(selectionKey, history, unreadCount);
        setMessages(history);
        if (selection.kind === "peer") void actions.refreshPeers();
        else void actions.refreshGroups();
      })
      .catch((error) => {
        if (!cancelled && !backendDisconnected.current)
          setStatus(
            `History error: ${error instanceof Error ? error.message : String(error)}`,
          );
      });
    return () => {
      cancelled = true;
    };
  }, [selectionKey]);

  useEffect(() => {
    const composer = composerRef.current;
    if (composer) setComposerHeight(getComposerHeight(composer));
  }, [selectionKey, width]);

  usePaste((event) => {
    if (dialog || editingName || isSending) return;
    try {
      const rawBytes = event.bytes;
      const eventMimeType = event.metadata?.mimeType?.toLowerCase();
      const imageMimeType = eventMimeType?.startsWith("image/")
        ? eventMimeType
        : detectImageMime(rawBytes);
      const eventIsImage = Boolean(imageMimeType);
      if (
        eventIsImage ||
        (event.metadata?.kind === "binary" &&
          !decodePasteBytes(rawBytes).trim())
      )
        event.preventDefault();
      if (eventIsImage && imageMimeType) {
        void actions.sendImage(rawBytes, imageMimeType);
        return;
      }
      const raw = decodePasteBytes(rawBytes).trim();
      if (!raw || event.metadata?.kind === "binary") {
        event.preventDefault();
        void clipboard.current
          ?.read({
            preferredTypes: [
              "image/png",
              "image/jpeg",
              "image/webp",
              "image/gif",
            ],
          })
          .then((result) => {
            if (result.status === "read")
              void actions.sendImage(
                result.representation.bytes,
                result.representation.mimeType,
              );
          })
          .catch(() => {});
        return;
      }
      // Plain-text paths are message text. Sending a file is always explicit.
    } catch {}
  });

  async function pasteFromHostClipboard() {
    const result = await clipboard.current?.read({
      preferredTypes: [
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
        "text/plain",
      ],
    });
    if (!result) {
      actions.showStatus("Host clipboard is not available.");
      return;
    }
    if (result.status !== "read") {
      actions.showStatus(
        result.status === "limit-exceeded"
          ? "Clipboard image exceeds the 8 MiB limit."
          : `Could not read host clipboard: ${result.status}`,
      );
      return;
    }
    if (result.representation.mimeType.startsWith("image/")) {
      await actions.sendImage(
        result.representation.bytes,
        result.representation.mimeType,
      );
      return;
    }
    if (result.representation.mimeType === "text/plain") {
      composerRef.current?.insertText(
        new TextDecoder().decode(result.representation.bytes),
      );
    }
  }

  useKeyboard((key) => {
    if (dialog && dialogBusyRef.current) return;
    if (deleteConfirmation) {
      if (key.name === "escape") {
        setDeleteConfirmation(undefined);
        actions.showStatus("Message deletion cancelled.");
        return;
      }
      if (key.name === "return" || key.name === "linefeed") {
        key.preventDefault();
        const message = deleteConfirmation;
        void ipc
          .send("delete_message", {
            message_id: message.id,
            group_id: message.groupId,
            file: message.kind === "file",
          })
          .then((response) => {
            if (response.error) throw new Error(response.error);
            if (message.kind === "file")
              setFileTransfers((current) =>
                current.filter((item) => item.file_id !== message.id),
              );
            else
              setMessages((current) =>
                current.filter((item) => item.message_id !== message.id),
              );
            setSelectedReplyTarget((current) =>
              current?.id === message.id ? undefined : current,
            );
            setReplyTo((current) =>
              current?.id === message.id ? undefined : current,
            );
            setDeleteConfirmation(undefined);
            actions.showStatus("Message deleted locally.");
          })
          .catch((error) => {
            setDeleteConfirmation(undefined);
            actions.showStatus(
              `Delete error: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
        return;
      }
      return;
    }
    const isPasteShortcut =
      key.name === "v" && (key.ctrl || key.meta || key.super);
    if (
      isPasteShortcut &&
      !dialog &&
      !editingName &&
      !scrollFocused &&
      !isSending &&
      selection
    ) {
      key.preventDefault();
      void pasteFromHostClipboard().catch(() => {});
      return;
    }
    if (key.ctrl && key.name === "p") {
      if (dialog?.kind === "commands") actions.closeDialog();
      else actions.showDialog({ kind: "commands" });
      return;
    }
    if (dialog) {
      if (key.name === "escape") actions.goBack();
      return;
    }
    if (key.name === "escape" && editingName) {
      setEditingName(false);
      setNameDraft(identity?.display_name ?? "");
      actions.showStatus("Name edit cancelled.");
      return;
    }
    if (key.ctrl && key.name === "n") {
      setNameDraft(identity?.display_name ?? "");
      setEditingName(true);
      return;
    }
    if (key.ctrl && key.name === "u") {
      void actions.openFilePicker();
      return;
    }
    if (key.ctrl && key.name === "d") {
      void actions.removeSelectedPeer();
      return;
    }
    if (
      scrollFocused &&
      !key.ctrl &&
      (key.name === "up" || key.name === "down")
    ) {
      const replyTargets = conversationItems.map((item): ReplyTarget =>
        item.type === "message"
          ? {
              id: item.message.message_id,
              senderId: item.message.sender_id,
              label: item.message.content,
              groupId: item.message.group_id,
              kind: "message",
            }
          : {
              id: item.file.file_id,
              senderId: item.file.sender_id,
              label: `Attachment: ${item.file.filename}`,
              groupId: item.file.group_id ?? undefined,
              kind: "file",
            },
      );
      if (!replyTargets.length) return;
      key.preventDefault();
      const index = selectedReplyTarget
        ? replyTargets.findIndex(
            (target) => target.id === selectedReplyTarget.id,
          )
        : -1;
      const nextIndex =
        index === -1
          ? key.name === "up"
            ? replyTargets.length - 1
            : 0
          : Math.max(
              0,
              Math.min(
                replyTargets.length - 1,
                index + (key.name === "up" ? -1 : 1),
              ),
            );
      setSelectedReplyTarget(replyTargets[nextIndex]);
      return;
    }
    if (scrollFocused && key.name === "r" && selectedReplyTarget) {
      key.preventDefault();
      setReplyTo(selectedReplyTarget);
      setScrollFocused(false);
      return;
    }
    if (
      scrollFocused &&
      (key.name === "return" || key.name === "linefeed") &&
      selectedReplyTarget?.kind === "file"
    ) {
      const selectedFile = conversationItems.find(
        (item): item is Extract<ConversationItem, { type: "file" }> =>
          item.type === "file" && item.file.file_id === selectedReplyTarget.id,
      )?.file;
      if (selectedFile?.file_path && isImageFile(selectedFile.filename)) {
        key.preventDefault();
        actions.showDialog({
          kind: "image-view",
          filePath: selectedFile.file_path,
          filename: selectedFile.filename,
          version: selectedFile.completed_at,
        });
      }
      return;
    }
    if (scrollFocused && key.name === "d" && selectedReplyTarget) {
      key.preventDefault();
      setDeleteConfirmation(selectedReplyTarget);
      return;
    }
    if (key.name === "escape" && replyTo) {
      setReplyTo(undefined);
      return;
    }
    if (
      (key.name === "up" || key.name === "down") &&
      key.ctrl &&
      (peers.length || groups.length)
    ) {
      const conversations: Conversation[] = [
        ...peers.map((peer) => ({ kind: "peer" as const, id: peer.peer_id })),
        ...groups.map((group) => ({
          kind: "group" as const,
          id: group.group_id,
        })),
      ];
      const index = conversations.findIndex(
        (item) => item.kind === selection?.kind && item.id === selection.id,
      );
      if (index === -1) {
        setSelection(
          key.name === "up"
            ? conversations[conversations.length - 1]
            : conversations[0],
        );
      } else {
        const direction = key.name === "up" ? -1 : 1;
        setSelection(
          conversations[
            (index + direction + conversations.length) % conversations.length
          ],
        );
      }
    }
    if (key.name === "pageup") {
      setScrollFocused(true);
      scrollboxRef.current?.scrollBy(-1, "viewport");
    }
    if (key.name === "pagedown") {
      setScrollFocused(true);
      scrollboxRef.current?.scrollBy(1, "viewport");
    }
    if (scrollFocused && key.name === "home") scrollboxRef.current?.scrollTo(0);
    if (scrollFocused && key.name === "end")
      scrollboxRef.current?.scrollTo(scrollboxRef.current.scrollHeight);
  });

  const selected = peers.find((peer) => peer.peer_id === selectedPeerId);
  const selectedHasCapabilityGap = Boolean(selected?.capability_gap);
  const capabilityGapParts = selected
    ? [
        selected.peer_missing_capabilities?.length
          ? `Peer does not support: ${selected.peer_missing_capabilities.join(", ")}.`
          : "",
        selected.local_missing_capabilities?.length
          ? `Peer supports features unavailable locally: ${selected.local_missing_capabilities.join(", ")}.`
          : "",
      ].filter(Boolean)
    : [];
  const capabilityGapMessage = capabilityGapParts.length
    ? `Limited capabilities. ${capabilityGapParts.join(" ")} Shared features remain available.`
    : "";
  const selectedGroup = groups.find(
    (group) => group.group_id === selectedGroupId,
  );
  const selectedTypingNames = Object.values(
    typingPeers[selectionKey ?? ""] ?? {},
  )
    .filter((peer) => peer.isTyping)
    .map((peer) => peer.displayName);
  const typingConversationKeys = new Set(
    Object.entries(typingPeers)
      .filter(([, peers]) => Object.values(peers).some((peer) => peer.isTyping))
      .map(([conversation]) => conversation),
  );
  const conversationFiles = useMemo(
    () =>
      fileTransfers
        .filter((f) => {
          if (f.status !== "completed" && f.status !== "sent") return false;
          if (selection?.kind === "peer")
            return (
              !f.group_id &&
              (f.sender_id === selection.id || f.recipient_id === selection.id)
            );
          if (selection?.kind === "group") return f.group_id === selection.id;
          return false;
        })
        .sort((a, b) => a.created_at - b.created_at),
    [fileTransfers, selection],
  );
  const conversationItems = useMemo<ConversationItem[]>(
    () =>
      [
        ...messages.map((message) => ({
          type: "message" as const,
          createdAt: message.created_at,
          message,
        })),
        ...conversationFiles.map((file) => ({
          type: "file" as const,
          createdAt: file.created_at,
          file,
        })),
      ].sort(
        (a, b) =>
          a.createdAt - b.createdAt ||
          (a.type === b.type ? 0 : a.type === "message" ? -1 : 1),
      ),
    [messages, conversationFiles],
  );
  const limitedGroupMembers = selectedGroup
    ? (groupMembers[selectedGroup.group_id] ?? []).filter(
        (member) => member.is_limited,
      )
    : [];
  const sidebarWidth = width < 72 ? 22 : 32;
  const compact = width < 72;
  const limitColor = composerLimitColor(draftLength);
  const dialogWidth = Math.min(68, Math.max(1, width - 4));
  const dialogHeight =
    dialog?.kind === "image-view"
      ? Math.max(1, height - 2)
      : Math.min(20, Math.max(1, height - 4));
  function dialogWidthFor(kind: Dialog["kind"]): number {
    if (kind === "image-view") return Math.max(1, width - 2);
    if (kind === "room-detail" || kind === "group-detail")
      return Math.min(78, Math.max(1, width - 2));
    return dialogWidth;
  }

  if (!appReady) return <StartupSplash message={startupMessage} width={width} height={height} />;

  return (
    <box
      style={{
        flexDirection: "row",
        width: "100%",
        height: "100%",
        minWidth: 0,
        padding: 1,
        gap: 1,
      }}
    >
      <Sidebar
        compact={compact}
        dialogOpen={Boolean(dialog)}
        editingName={editingName}
        groups={groups}
        groupMembers={groupMembers}
        identity={identity}
        mutedPeers={mutedPeers}
        nameDraft={nameDraft}
        peers={peers}
        selectedGroupId={selectedGroupId}
        selectedPeerId={selectedPeerId}
        sidebarWidth={sidebarWidth}
        typingConversationKeys={typingConversationKeys}
        openGroupDetails={(group) => void actions.loadGroupDetails(group)}
        setEditingName={setEditingName}
        setNameDraft={setNameDraft}
        setSelection={setSelection}
        setScrollFocused={setScrollFocused}
        saveDisplayName={() => void actions.saveDisplayName()}
      />
      <ConversationPanel
        compact={compact}
        controlStatus={controlStatus}
        conversationItems={conversationItems}
        deliveredMessageIds={deliveredMessageIds}
        dialogOpen={Boolean(dialog)}
        draftLength={draftLength}
        drafts={drafts}
        flashingEnabled={flashingEnabled}
        blinkOn={blinkOn}
        composerHeight={composerHeight}
        composerRef={composerRef}
        groupMembers={groupMembers}
        identity={identity}
        imageProtocol={imageProtocol}
        limitedGroupMembers={limitedGroupMembers}
        capabilityGapMessage={capabilityGapMessage}
        isSending={isSending}
        limitColor={limitColor}
        mutedPeers={mutedPeers}
        peers={peers}
        selected={selected}
        selectedGroup={selectedGroup}
        selectedGroupId={selectedGroupId}
        selectedHasCapabilityGap={selectedHasCapabilityGap}
        selectedReplyTargetId={selectedReplyTarget?.id}
        replyTo={replyTo}
        selectionKey={selectionKey}
        typingNames={selectedTypingNames}
        editingName={editingName}
        scrollFocused={scrollFocused}
        scrollboxRef={scrollboxRef}
        status={status}
        width={width}
        unreadMessageStates={unreadMessages}
        unreadNow={unreadNow}
        markUnreadMessageVisible={markUnreadMessageVisible}
        openImage={(file) => {
          if (file.file_path)
            actions.showDialog({
              kind: "image-view",
              filePath: file.file_path,
              filename: file.filename,
              version: file.completed_at,
            });
        }}
        openDeliveryDetails={(deliveries) =>
          actions.showDialog({ kind: "delivery-details", deliveries })
        }
        setComposerHeight={setComposerHeight}
        setDraftLength={setDraftLength}
        setScrollFocused={setScrollFocused}
        selectReplyTarget={(target) => {
          setSelectedReplyTarget(target);
          setScrollFocused(true);
        }}
        onComposerChange={handleComposerChange}
        send={() => {
          stopOutgoingTyping();
          void actions.send(replyTo?.id).then((sent) => {
            if (sent) setReplyTo(undefined);
          });
        }}
      />
      {deleteConfirmation && (
        <box
          style={{
            position: "absolute",
            left: Math.max(2, Math.floor(width / 2) - 24),
            top: Math.max(1, Math.floor(height / 2) - 2),
            width: Math.min(48, Math.max(1, width - 4)),
            border: true,
            borderColor: "#ff7777",
            backgroundColor: "#2d1818",
            padding: 1,
            flexDirection: "column",
          }}
        >
          <text fg="#ff7777">
            <b>Delete this message locally?</b>
          </text>
          <text fg="#bbbbbb">
            Enter confirms. Esc cancels. This is not sent to peers.
          </text>
        </box>
      )}
      {copyToast && (
        <box
          style={{
            position: "absolute",
            right: 2,
            top: 1,
            border: true,
            borderColor: "#66dd88",
            backgroundColor: "#18251d",
            paddingLeft: 1,
            paddingRight: 1,
          }}
        >
          <text fg="#66dd88">Copied to clipboard</text>
        </box>
      )}
      {dialog && (
        <DialogPanel
          dialog={dialog}
          dialogBusy={dialogBusy}
          dialogError={dialogError}
          dialogHeight={dialogHeight}
          dialogWidth={dialogWidth}
          dialogDraft={dialogDraft}
          controlStatus={controlStatus}
          debugInfo={debugInfo}
          flashingEnabled={flashingEnabled}
          imageProtocol={imageProtocol}
          groups={groups}
          identity={identity}
          mutedPeers={mutedPeers}
          notificationPreferences={notificationPreferences}
          notificationTestDelivery={notificationTestDelivery}
          peers={peers}
          selected={selected}
          selectedGroupId={selectedGroupId}
          selection={selection}
          dialogWidthFor={dialogWidthFor}
          appReleaseVersion={APP_RELEASE_VERSION}
          isReleaseBuild={IS_RELEASE_BUILD}
          runCommand={actions.runCommand}
          showDialog={actions.showDialog}
          closeDialog={actions.closeDialog}
          goBack={actions.goBack}
          setDialogDraft={setDialogDraft}
          setDialogError={setDialogError}
          setNameDraft={setNameDraft}
          configureControl={actions.configureControl}
          dismissControlSetup={actions.dismissControlSetup}
          loadControlStatus={actions.loadControlStatus}
          saveAdvancedConfig={actions.saveAdvancedConfig}
          setAccessibilityFlashing={actions.setAccessibilityFlashing}
          createRoom={actions.createRoom}
          joinRoom={actions.joinRoom}
          leaveRoom={actions.leaveRoom}
          loadRoomInvite={actions.loadRoomInvite}
          loadRooms={actions.loadRooms}
          copyInvite={actions.copyInvite}
          leaveGroup={actions.leaveGroup}
          loadGroupDetails={actions.loadGroupDetails}
          mutePeer={actions.mutePeer}
          unmutePeer={actions.unmutePeer}
          sendFriendRequest={actions.sendFriendRequest}
          respondToFriendRequest={actions.respondToFriendRequest}
          cancelFriendRequest={actions.cancelFriendRequest}
          unfriendPeer={actions.unfriendPeer}
          loadFriendRequests={actions.loadFriendRequests}
          loadBlockedPeers={actions.loadBlockedPeers}
          blockPeer={actions.blockPeer}
          unblockPeer={actions.unblockPeer}
          blockSenderFromRequest={actions.blockSenderFromRequest}
          reStun={actions.reStun}
          loadDebugInfo={actions.loadDebugInfo}
          loadFiles={actions.loadFiles}
          loadFilesDir={actions.loadFilesDir}
          setFilesDir={actions.setFilesDir}
          sendFile={actions.sendFile}
          downloadFile={actions.downloadFile}
          defaultDownloadPath={actions.defaultDownloadPath}
          testNotificationDelivery={actions.testNotificationDelivery}
          disableNotifications={actions.disableNotifications}
          confirmNotificationDelivery={actions.confirmNotificationDelivery}
          toggleNotificationEvent={actions.toggleNotificationEvent}
          saveDisplayName={actions.saveDisplayName}
          checkForUpdatesFromAbout={actions.checkForUpdatesFromAbout}
          installUpdate={actions.installUpdate}
          saveUpdateToken={actions.saveUpdateToken}
          restartUpdate={actions.restartUpdate}
        />
      )}
      {!dialog && (
        <box style={{ position: "absolute", right: 1, bottom: 0 }}>
          <text>
            <span fg="#66dd88">● </span>
            <span fg="#bbbbbb">MeshTalk </span>
            <span fg="#888888">{APP_RELEASE_VERSION}</span>
          </text>
        </box>
      )}
    </box>
  );
}
