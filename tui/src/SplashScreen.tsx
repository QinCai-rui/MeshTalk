import { type BoxRenderable } from "@opentui/core";
import { useTimeline } from "@opentui/react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { chatTheme as theme } from "./chatTheme";

declare const APP_VERSION: string;
declare const MESHTALK_RELEASE: boolean;

export const IS_RELEASE_BUILD =
  typeof MESHTALK_RELEASE !== "undefined" && MESHTALK_RELEASE;
export const APP_RELEASE_VERSION =
  typeof APP_VERSION !== "undefined" && APP_VERSION ? APP_VERSION : "dev";
export const MIN_SPLASH_PHASE_MS = 300;
export const MIN_SPLASH_DURATION_MS = 3000;
export const MIN_SPLASH_WELCOME_MS = 200;

export type SplashStyle = "card" | "boot-log";

export enum StartupPhase {
  Renderer = "renderer",
  IpcConnect = "ipc_connect",
  Authenticate = "authenticate",
  LoadIdentity = "load_identity",
  AnnouncePresence = "announce_presence",
  LoadData = "load_data",
  Ready = "ready",
}

const PHASE_LABELS: Partial<Record<StartupPhase, string>> = {
  [StartupPhase.Renderer]: "graphics: terminal renderer initialized",
  [StartupPhase.IpcConnect]: "ipc: connecting to MeshTalk backend",
  [StartupPhase.Authenticate]: "security: IPC session authenticated",
  [StartupPhase.LoadIdentity]: "identity: local node identity loaded",
  [StartupPhase.AnnouncePresence]: "mesh: local presence announced",
  [StartupPhase.LoadData]: "state: conversations and contacts loaded",
};
const PHASE_COMPLETION_LABELS: Partial<Record<StartupPhase, string>> = {
  [StartupPhase.IpcConnect]: "ipc: connected to MeshTalk backend",
};

const MESHTALK_WORDMARK = [
  "███╗   ███╗███████╗███████╗██╗  ██╗████████╗ █████╗ ██╗     ██╗  ██╗",
  "████╗ ████║██╔════╝██╔════╝██║  ██║╚══██╔══╝██╔══██╗██║     ██║ ██╔╝",
  "██╔████╔██║█████╗  ███████╗███████║   ██║   ███████║██║     █████╔╝ ",
  "██║╚██╔╝██║██╔══╝  ╚════██║██╔══██║   ██║   ██╔══██║██║     ██╔═██╗ ",
  "██║ ╚═╝ ██║███████╗███████║██║  ██║   ██║   ██║  ██║███████╗██║  ██╗",
  "╚═╝     ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝",
] as const;
const MESHTALK_WORDMARK_COLORS = theme.splash.wordmark;
const STARTUP_PHASES = ["GRAPHICS", "BACKEND", "CONTACTS", "READY"] as const;
const STARTUP_BURST = [
  ["", "", "                                    ·", "", "", ""],
  ["", "                    ·     ✦     ·", "             ·   ╲     ◈     ╱   ·", "                    ·     ✦     ·", "", ""],
  ["           ·   ✦   ·    ╲   ╱    ·   ✦   ·", "       ✦       ╲      ═  ◈  ═      ╱       ✦", "   ·       ═══════     ╱   ╲     ═══════       ·", "       ✦       ╱      ═  ◈  ═      ╲       ✦", "           ·   ✦   ·    ╱   ╲    ·   ✦   ·", ""],
  ["", "              ✦                    ✦", "        ═════════   ◈◈◈   ═════════", "              ✦                    ✦", "", ""],
] as const;
const STARTUP_BURST_COLORS = [theme.splash.accent, theme.splash.violet, theme.splash.pink, theme.splash.gold] as const;
const BRAILLE_SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

let logIdCounter = 0;
function nextLogId(): number {
  logIdCounter += 1;
  return logIdCounter;
}

function formatKernelTimestamp(elapsedMs: number): string {
  const totalSeconds = elapsedMs / 1000;
  const whole = Math.floor(totalSeconds).toString().padStart(5, " ");
  const micros = Math.round((totalSeconds - Math.floor(totalSeconds)) * 1_000_000)
    .toString()
    .padStart(6, "0");
  return `${whole}.${micros}`;
}

function phaseIndex(phase: StartupPhase | null): number {
  if (phase === StartupPhase.Ready) return 3;
  if (phase === StartupPhase.LoadData) return 2;
  if (phase && phase !== StartupPhase.Renderer) return 1;
  return 0;
}

type LogEntry = {
  id: number;
  startedAt: number;
  finishedAt?: number;
  text: string;
  kind: "phase" | "final" | "welcome";
};

export type StartupOutcome<T> = {
  result: T;
  durationMs?: number;
  phaseDurationMs?: number;
  welcomeDurationMs?: number;
};

type StartupSplashProps<T> = {
  start: (setPhase: (phase: StartupPhase) => Promise<void>) => Promise<StartupOutcome<T>>;
  onReady: (result: T) => void;
  onError: (error: unknown) => void;
  variant: SplashStyle | false;
  phaseDurationMs?: number;
  welcomeDurationMs?: number;
  width: number;
  height: number;
};

type SplashState = {
  activePhaseId: number | null;
  countdown: "loading" | "welcome" | "starting" | null;
  currentPhase: StartupPhase | null;
  cursorVisible: boolean;
  log: LogEntry[];
  mountTime: number;
  ready: boolean;
  spinnerChar: string;
  welcomeMessage: string;
  cardStatus: "graphics" | "connecting" | "waiting" | "loading" | "ready";
};

function useSplashStartup<T>({ start, onReady, onError, phaseDurationMs, welcomeDurationMs }: StartupSplashProps<T>): SplashState {
  const mountTimeRef = useRef(performance.now());
  const [log, setLog] = useState<LogEntry[]>([]);
  const [spinnerTick, setSpinnerTick] = useState(0);
  const currentPhase = useRef<StartupPhase | null>(null);
  const activeLogId = useRef<number | null>(null);
  const phaseLogged = useRef(new Set<StartupPhase>());
  const [countdown, setCountdown] = useState<"loading" | "welcome" | "starting" | null>(null);
  const onReadyCalled = useRef(false);
  const phaseDurationRef = useRef(MIN_SPLASH_PHASE_MS);

  phaseDurationRef.current = Math.max(0, phaseDurationMs ?? MIN_SPLASH_PHASE_MS);

  function cardStatusFor(phase: StartupPhase): SplashState["cardStatus"] {
    if (phase === StartupPhase.Ready) return "ready";
    if (phase === StartupPhase.LoadIdentity || phase === StartupPhase.AnnouncePresence || phase === StartupPhase.LoadData) return "loading";
    if (phase === StartupPhase.IpcConnect || phase === StartupPhase.Authenticate) return "connecting";
    return "graphics";
  }

  const stage = (phase: StartupPhase): number => phaseIndex(phase);
  const stageRef = useRef(-1);

  function setPhase(phase: StartupPhase): Promise<void> {
    if (currentPhase.current === phase) return Promise.resolve();
    const startedAt = performance.now();
    const previousLogId = activeLogId.current;
    const previousPhase = currentPhase.current;
    currentPhase.current = phase;
    const text = PHASE_LABELS[phase] ?? "";
    if (!text) return Promise.resolve();
    const alreadyLogged = phaseLogged.current.has(phase);
    const id = alreadyLogged ? null : nextLogId();
    if (!alreadyLogged) {
      phaseLogged.current.add(phase);
      activeLogId.current = id;
    }
    setLog((previous) => {
      const completed = previousLogId === null
        ? previous
        : previous.map((entry) => entry.id === previousLogId && entry.finishedAt === undefined
          ? { ...entry, finishedAt: startedAt, text: (previousPhase && PHASE_COMPLETION_LABELS[previousPhase]) ?? entry.text }
          : entry);
      if (alreadyLogged || id === null) return completed;
      return [...completed, { id, startedAt, text, kind: "phase" }];
    });
    const nextStage = stage(phase);
    if (nextStage === stageRef.current) return Promise.resolve();
    stageRef.current = nextStage;
    return new Promise((resolve) => setTimeout(resolve, phaseDurationRef.current));
  }

  const welcomeMessage = `Welcome to MeshTalk ${APP_RELEASE_VERSION} (${IS_RELEASE_BUILD ? "stable" : "dev"}, ${process.platform ?? "unknown"})`;

  useEffect(() => {
    let cancelled = false;
    let readyTimer: ReturnType<typeof setTimeout> | undefined;
    let startingTimer: ReturnType<typeof setTimeout> | undefined;

    void start(setPhase)
      .then(({ result, durationMs, phaseDurationMs, welcomeDurationMs: configuredWelcomeDurationMs }) => {
        if (cancelled) return;
        if (phaseDurationMs !== undefined)
          phaseDurationRef.current = Math.max(0, phaseDurationMs);
        const welcomeDuration = Math.max(0, configuredWelcomeDurationMs ?? welcomeDurationMs ?? MIN_SPLASH_WELCOME_MS);
        const duration = Math.max(welcomeDuration + 100, durationMs ?? MIN_SPLASH_DURATION_MS);
        const startsAt = mountTimeRef.current + duration - welcomeDuration - 100;

        const finalPhaseId = activeLogId.current;
        activeLogId.current = null;
        setLog((previous) => previous.map((entry) =>
          entry.id === finalPhaseId && entry.finishedAt === undefined
            ? { ...entry, finishedAt: performance.now() }
            : entry,
        ));

        currentPhase.current = StartupPhase.Ready;
        setCountdown("loading");
        readyTimer = setTimeout(() => {
          if (cancelled || onReadyCalled.current) return;
          const startedAt = performance.now();
          setLog((previous) => [...previous, { id: nextLogId(), startedAt, finishedAt: startedAt, text: welcomeMessage, kind: "welcome" }]);
          setCountdown("welcome");
          startingTimer = setTimeout(() => {
            if (cancelled || onReadyCalled.current) return;
            setCountdown("starting");
            startingTimer = setTimeout(() => {
              if (cancelled || onReadyCalled.current) return;
              onReadyCalled.current = true;
              onReady(result);
            }, 100);
          }, welcomeDuration);
        }, Math.max(0, startsAt - performance.now()));
      })
      .catch((error) => {
        if (cancelled || onReadyCalled.current) return;
        onReadyCalled.current = true;
        const now = performance.now();
        const text = `startup error: ${error instanceof Error ? error.message : String(error)}`;
        setLog((previous) => [...previous, { id: nextLogId(), startedAt: now, finishedAt: now, text, kind: "final" }]);
        onError(error);
      });

    return () => {
      cancelled = true;
      if (readyTimer) clearTimeout(readyTimer);
      if (startingTimer) clearTimeout(startingTimer);
    };
  }, []);

  useEffect(() => {
    const id = setInterval(() => setSpinnerTick((tick) => tick + 1), 90);
    return () => clearInterval(id);
  }, []);

  const activePhaseId = useMemo(
    () => [...log].reverse().find((entry) => entry.kind === "phase")?.id ?? null,
    [log],
  );

  return {
    activePhaseId,
    countdown,
    currentPhase: currentPhase.current,
    cursorVisible: spinnerTick % 10 < 6,
    log,
    mountTime: mountTimeRef.current,
    ready: currentPhase.current === StartupPhase.Ready,
    spinnerChar: BRAILLE_SPINNER[spinnerTick % BRAILLE_SPINNER.length],
    cardStatus: cardStatusFor(currentPhase.current ?? StartupPhase.Renderer),
    welcomeMessage,
  };
}

export function StartupSplash<T>(props: StartupSplashProps<T>) {
  const startup = useSplashStartup(props);

  if (props.variant === false)
    return (
      <box
        style={{
          width: "100%",
          height: "100%",
          backgroundColor: theme.splash.canvas,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <box
          title=" MeshTalk "
          titleColor={theme.splash.title}
          style={{
            width: Math.min(48, Math.max(24, props.width - 4)),
            border: true,
            borderColor: theme.splash.border,
            backgroundColor: theme.splash.surface,
            padding: 1,
            flexDirection: "column",
            gap: 1,
          }}
        >
          <text fg={theme.warning}><b>Splash screen is not enabled.</b></text>
          <text fg={theme.splash.notice}>MeshTalk is starting.</text>
          <text fg={theme.splash.notice} wrapMode="word">Enable: Settings &gt; Customisation &gt; Splash screen.</text>
          <text fg={theme.splash.subtle} wrapMode="word">Or launch with `meshtalk --splash=card`.</text>
        </box>
      </box>
    );
  if (props.variant === "card") return <CardSplash width={props.width} height={props.height} startup={startup} />;
  return <BootLogSplash width={props.width} height={props.height} startup={startup} />;
}

function CardSplash({ width, height, startup }: { width: number; height: number; startup: SplashState }) {
  const wide = width >= 82 && height >= 19;
  const compact = width < 48 || height < 14;
  const cardWidth = Math.min(wide ? 78 : 58, Math.max(24, width - 4));
  const sweepRef = useRef<BoxRenderable>(null);
  const trailRef1 = useRef<BoxRenderable>(null);
  const trailRef2 = useRef<BoxRenderable>(null);
  const sweepTimeline = useTimeline({ autoplay: false, duration: 1800, loop: true });
  const [burstFrame, setBurstFrame] = useState(0);
  const phase = phaseIndex(startup.currentPhase);
  const phaseNumber = String(phase + 1).padStart(2, "0");
  const status = startup.countdown === "starting"
    ? "starting..."
    : startup.countdown === "welcome"
      ? "ready"
    : startup.countdown === "loading"
      ? startup.ready ? "ready" : "loading..."
      : startup.cardStatus === "graphics"
        ? "Preparing terminal graphics..."
        : startup.cardStatus === "connecting"
          ? "Connecting to MeshTalk backend..."
          : startup.cardStatus === "waiting"
            ? "Waiting for MeshTalk backend..."
            : startup.cardStatus === "loading"
              ? "Loading conversations and contacts..."
              : "starting...";

  useEffect(() => {
    const sweep = sweepRef.current;
    const trail1 = trailRef1.current;
    const trail2 = trailRef2.current;
    if (!sweep) return;
    const distance = Math.max(1, cardWidth - 5);

    sweepTimeline.add(sweep, { translateX: distance, duration: 1250, ease: "inOutSine" }, 0);
    sweepTimeline.add(sweep, { translateX: 0, duration: 550, ease: "inOutSine" }, 1250);
    if (trail1) {
      sweepTimeline.add(trail1, { translateX: distance, duration: 1250, ease: "inOutSine" }, 60);
      sweepTimeline.add(trail1, { translateX: 0, duration: 550, ease: "inOutSine" }, 1310);
      sweepTimeline.add(trail1, { opacity: 0.55, duration: 200, ease: "outQuad" }, 60);
      sweepTimeline.add(trail1, { opacity: 0.15, duration: 300, ease: "inQuad" }, 1250);
      sweepTimeline.add(trail1, { opacity: 0.55, duration: 200, ease: "outQuad" }, 1550);
    }
    if (trail2) {
      sweepTimeline.add(trail2, { translateX: distance, duration: 1250, ease: "inOutSine" }, 130);
      sweepTimeline.add(trail2, { translateX: 0, duration: 550, ease: "inOutSine" }, 1380);
      sweepTimeline.add(trail2, { opacity: 0.3, duration: 200, ease: "outQuad" }, 130);
      sweepTimeline.add(trail2, { opacity: 0.05, duration: 300, ease: "inQuad" }, 1250);
      sweepTimeline.add(trail2, { opacity: 0.3, duration: 200, ease: "outQuad" }, 1550);
    }
    sweepTimeline.play();
    return () => { sweepTimeline.pause(); };
  }, [cardWidth, sweepTimeline]);

  useEffect(() => {
    const timers = [90, 190, 300, 420].map((delay, index) => setTimeout(() => setBurstFrame(index + 1), delay));
    return () => timers.forEach(clearTimeout);
  }, []);

  const burstColor = STARTUP_BURST_COLORS[Math.min(burstFrame, STARTUP_BURST_COLORS.length - 1)];
  return (
    <box style={{ width: "100%", height: "100%", alignItems: "center", justifyContent: "center", backgroundColor: theme.splash.canvas }}>
      <box
        title={compact ? undefined : " ◇ MeshTalk // Let's Get Meshing! ◇ "}
        titleColor={theme.splash.title}
        style={{ width: cardWidth, border: true, borderColor: theme.splash.border, backgroundColor: theme.splash.surface, padding: 1, flexDirection: "column", overflow: "hidden" }}
      >
        <box style={{ width: "100%", marginBottom: 1, flexDirection: "row", justifyContent: "space-between" }}>
          <text><span fg={theme.splash.build}>{IS_RELEASE_BUILD ? "● STABLE" : "◐ DEV BUILD"}</span></text>
          <text><span fg={theme.splash.buildLabel}>VERSION </span><span fg={theme.splash.title}><b>{APP_RELEASE_VERSION}</b></span></text>
        </box>

        {wide ? <box style={{ width: "100%", height: 7, flexDirection: "column", justifyContent: "center", alignItems: "center" }}>
          {burstFrame < STARTUP_BURST.length
            ? STARTUP_BURST[burstFrame].map((line, index) => <text key={`${burstFrame}-${index}`} wrapMode="none" fg={index === 2 ? theme.splash.white : burstColor}><b>{line}</b></text>)
            : MESHTALK_WORDMARK.map((line, index) => <text key={line} wrapMode="none" fg={MESHTALK_WORDMARK_COLORS[index]}><b>{line}</b></text>)}
        </box> : <box style={{ height: compact ? 3 : 5, flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
          {!compact ? <text fg={theme.splash.divider}>◇ ─────────────── ◇</text> : null}
          {burstFrame < STARTUP_BURST.length
            ? <text fg={burstColor}><b>{burstFrame === 0 ? "·" : burstFrame === 1 ? "·  ✦  ·" : burstFrame === 2 ? "✦ ═══ ◈ ═══ ✦" : "✦  ◈◈◈  ✦"}</b></text>
            : <text><span fg={theme.splash.mesh}><b>MESH</b></span><span fg={theme.splash.talk}><b>TALK</b></span></text>}
          <text fg={theme.splash.muted}>DIRECT  •  PRIVATE  •  TERMINAL-NATIVE</text>
          {!compact ? <text fg={theme.splash.divider}>◇ ─────────────── ◇</text> : null}
        </box>}

        <box style={{ width: "100%", height: 1, marginTop: 1, backgroundColor: theme.splash.progressTrack, overflow: "hidden" }}>
          <box ref={trailRef2} width={1} height={1} backgroundColor={theme.splash.accent} opacity={0.05}><text fg={theme.splash.accentLight}>◆</text></box>
          <box ref={trailRef1} width={1} height={1} backgroundColor={theme.splash.accent} opacity={0.15}><text fg={theme.splash.accentLight}>◆</text></box>
          <box ref={sweepRef} width={1} height={1} backgroundColor={theme.splash.accent}><text fg={theme.splash.accentLight}>◆</text></box>
        </box>

        <box style={{ width: "100%", marginTop: 1, flexDirection: "row", alignItems: "center", justifyContent: "center" }}>
          <text><span fg={theme.splash.phaseMuted}>{phaseNumber} / 04  </span><span fg={theme.splash.phaseText}><b>{status}</b></span></text>
        </box>

        {!compact ? <box style={{ width: "100%", marginTop: 1, flexDirection: "row", alignItems: "center", justifyContent: "center" }}>
          {STARTUP_PHASES.map((label, index) => (
            <text key={label}>
              <span fg={index < phase ? theme.splash.accent : index === phase ? theme.splash.violet : theme.splash.dim}>{index <= phase ? "●" : "○"}</span>
              <span fg={index === phase ? theme.splash.phaseActiveText : theme.splash.phaseInactiveText}> {label}</span>
              {index < STARTUP_PHASES.length - 1 ? <span fg={theme.splash.connector}>{"  ─  "}</span> : null}
            </text>
          ))}
        </box> : null}
      </box>
    </box>
  );
}

function BootLogSplash({ width, height, startup }: { width: number; height: number; startup: SplashState }) {
  const wide = width >= 82 && height >= 19;
  const compact = width < 48 || height < 14;
  return (
    <box style={{ width: "100%", height: "100%", flexDirection: "column", alignItems: "flex-start", justifyContent: "flex-start", backgroundColor: theme.splash.logCanvas, padding: compact ? 1 : 2 }}>
      {wide ? <box style={{ flexDirection: "column" }}>
        {MESHTALK_WORDMARK.map((line, index) => <text key={line} wrapMode="none" fg={MESHTALK_WORDMARK_COLORS[index]}><b>{line}</b></text>)}
      </box> : <text><span fg={theme.splash.violet}><b>MESH</b></span><span fg={theme.splash.accent}><b>TALK</b></span></text>}

      <text>
        <span fg={theme.splash.phaseInactiveText}>Welcome to </span><span fg={theme.splash.text}><b>MeshTalk</b></span><span fg={theme.splash.phaseInactiveText}> </span><span fg={theme.splash.version}>{APP_RELEASE_VERSION}</span><span fg={theme.splash.phaseInactiveText}> ({IS_RELEASE_BUILD ? "stable" : "dev"}, {process.platform ?? "unknown"})</span>
      </text>
      <box style={{ height: 1 }} />

      {startup.log.map((entry) => {
        const isWelcome = entry.kind === "welcome";
        const active = entry.kind === "phase" && entry.id === startup.activePhaseId && entry.finishedAt === undefined && !startup.ready;
        const tag = isWelcome ? null : entry.kind === "final" ? <span fg={theme.splash.accent}>[ OK ] </span> : active ? <span fg={theme.splash.violet}>[ {startup.spinnerChar} ] </span> : <span fg={theme.splash.bootSuccess}>[ OK ] </span>;
        const color = isWelcome ? theme.splash.pink : entry.kind === "final" ? theme.splash.accent : active ? theme.splash.text : theme.splash.phaseInactiveText;
        const elapsedMs = (entry.finishedAt ?? performance.now()) - startup.mountTime;
        return <Fragment key={entry.id}>
          {isWelcome ? <text key={`${entry.id}-gap`}> </text> : null}
          <text><span fg={theme.splash.dim}>[{formatKernelTimestamp(elapsedMs)}] </span>{tag}<span fg={color}><b>{entry.text}</b></span>{active && startup.cursorVisible ? <span fg={theme.splash.accent}> ▊</span> : null}</text>
        </Fragment>;
      })}

      {startup.countdown && startup.countdown !== "welcome" ? <text>
        <span fg={theme.splash.dim}>[{formatKernelTimestamp(performance.now() - startup.mountTime)}] </span>
        <span fg={startup.countdown === "starting" ? theme.splash.accent : theme.splash.violet}>[{startup.countdown === "starting" ? " OK " : ` ${startup.spinnerChar} `}] </span>
        <span fg={startup.countdown === "starting" ? theme.splash.accent : theme.splash.text}><b>{startup.countdown === "starting" ? "starting..." : "loading..."}</b></span>
      </text> : null}
    </box>
  );
}
