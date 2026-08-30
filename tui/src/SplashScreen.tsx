import { type BoxRenderable } from "@opentui/core";
import { useTimeline } from "@opentui/react";
import { useEffect, useRef, useState } from "react";

declare const APP_VERSION: string;
declare const MESHTALK_RELEASE: boolean;

export const IS_RELEASE_BUILD =
  typeof MESHTALK_RELEASE !== "undefined" && MESHTALK_RELEASE;
export const APP_RELEASE_VERSION =
  typeof APP_VERSION !== "undefined" && APP_VERSION ? APP_VERSION : "dev";
export const MIN_SPLASH_PHASE_MS = 500;
export const MIN_SPLASH_DURATION_MS = 4000;

const MESHTALK_WORDMARK = [
  "███╗   ███╗███████╗███████╗██╗  ██╗████████╗ █████╗ ██╗     ██╗  ██╗",
  "████╗ ████║██╔════╝██╔════╝██║  ██║╚══██╔══╝██╔══██╗██║     ██║ ██╔╝",
  "██╔████╔██║█████╗  ███████╗███████║   ██║   ███████║██║     █████╔╝ ",
  "██║╚██╔╝██║██╔══╝  ╚════██║██╔══██║   ██║   ██╔══██║██║     ██╔═██╗ ",
  "██║ ╚═╝ ██║███████╗███████║██║  ██║   ██║   ██║  ██║███████╗██║  ██╗",
  "╚═╝     ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝   ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝",
] as const;
const MESHTALK_WORDMARK_COLORS = ["#d7e3ff", "#becff5", "#a4bbed", "#8aa6df", "#718fcf", "#5d7abd"] as const;

const STARTUP_PHASES = ["GRAPHICS", "BACKEND", "CONTACTS", "READY"] as const;
const STARTUP_BURST = [
  ["", "", "                                    ·", "", "", ""],
  ["", "                    ·     ✦     ·", "             ·   ╲     ◈     ╱   ·", "                    ·     ✦     ·", "", ""],
  ["           ·   ✦   ·    ╲   ╱    ·   ✦   ·", "       ✦       ╲      ═  ◈  ═      ╱       ✦", "   ·       ═══════     ╱   ╲     ═══════       ·", "       ✦       ╱      ═  ◈  ═      ╲       ✦", "           ·   ✦   ·    ╱   ╲    ·   ✦   ·", ""],
] as const;

export function StartupSplash({ message, width, height }: { message: string; width: number; height: number }) {
  const wide = width >= 82 && height >= 19;
  const compact = width < 48 || height < 14;
  const cardWidth = Math.min(wide ? 78 : 58, Math.max(24, width - 4));
  const sweepRef = useRef<BoxRenderable>(null);
  const sweepTimeline = useTimeline({ autoplay: false, duration: 1800, loop: true });
  const [burstFrame, setBurstFrame] = useState(0);

  function startupPhaseIndex(msg: string): number {
    if (msg.startsWith("Finalising")) return 3;
    if (msg.startsWith("Loading")) return 2;
    if (msg.startsWith("Connecting") || msg.startsWith("Waiting")) return 1;
    return 0;
  }
  const phase = startupPhaseIndex(message);
  const phaseNumber = String(phase + 1).padStart(2, "0");

  useEffect(() => {
    const sweep = sweepRef.current;
    if (!sweep) return;
    sweepTimeline.add(sweep, { translateX: Math.max(1, cardWidth - 5), duration: 1250, ease: "inOutSine" }, 0);
    sweepTimeline.add(sweep, { translateX: 0, duration: 550, ease: "inOutSine" }, 1250);
    sweepTimeline.play();
    return () => { sweepTimeline.pause(); };
  }, [cardWidth, sweepTimeline]);

  useEffect(() => {
    const timers = [100, 200, 300].map((delay, index) => setTimeout(() => setBurstFrame(index + 1), delay));
    return () => timers.forEach(clearTimeout);
  }, []);

  return (
    <box
      style={{
        width: "100%",
        height: "100%",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#070a0f",
      }}
    >
      <box
        title={compact ? undefined : " MeshTalk // Let's Get Meshing! "}
        titleColor="#8097c8"
        style={{
          width: cardWidth,
          border: true,
          borderColor: "#42587e",
          backgroundColor: "#0d131d",
          padding: 1,
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <box style={{ width: "100%", marginBottom: 1, flexDirection: "row", justifyContent: "flex-end" }}>
          <text><span fg="#3f516f">VERSION </span><span fg="#8fa7c9">{APP_RELEASE_VERSION}</span></text>
        </box>

        {wide ? <box style={{ width: "100%", height: 7, flexDirection: "column", justifyContent: "center", alignItems: "center" }}>
          {burstFrame < STARTUP_BURST.length
            ? STARTUP_BURST[burstFrame].map((line, index) => <text key={`${burstFrame}-${index}`} wrapMode="none" fg={index === 2 ? "#f0d7ff" : "#65d6b4"}><b>{line}</b></text>)
            : MESHTALK_WORDMARK.map((line, index) => <text key={line} wrapMode="none" fg={MESHTALK_WORDMARK_COLORS[index]}><b>{line}</b></text>)}
        </box> : <box style={{ height: compact ? 3 : 5, flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
          {!compact ? <text fg="#354867">◆──────────◆</text> : null}
          {burstFrame < STARTUP_BURST.length ? <text fg="#f0d7ff"><b>{burstFrame === 0 ? "·" : burstFrame === 1 ? "·  ✦  ·" : "✦ ═══ ◈ ═══ ✦"}</b></text> : <text><span fg="#a997ff"><b>MESH</b></span><span fg="#65d6b4"><b>TALK</b></span></text>}
          <text fg="#526988">DIRECT  •  PRIVATE  •  TERMINAL-NATIVE</text>
          {!compact ? <text fg="#354867">◆──────────◆</text> : null}
        </box>}

        <box style={{ width: "100%", height: 1, backgroundColor: "#17243a", overflow: "hidden" }}>
          <box ref={sweepRef} width={1} height={1} backgroundColor="#65d6b4"><text fg="#d8fff1">◆</text></box>
        </box>

        <box style={{ width: "100%", flexDirection: "row", alignItems: "center", justifyContent: "center" }}>
          <text><span fg="#60708d">{phaseNumber} / 04  </span><span fg="#d5deed"><b>{message}</b></span></text>
        </box>

        {!compact ? <box style={{ width: "100%", flexDirection: "row", justifyContent: "space-between" }}>
          {STARTUP_PHASES.map((label, index) => <text key={label}><span fg={index < phase ? "#65d6b4" : index === phase ? "#a997ff" : "#35445d"}>{index <= phase ? "●" : "○"}</span><span fg={index === phase ? "#c7d3e8" : "#526078"}> {label}</span></text>)}
        </box> : null}

      </box>

    </box>
  );
}
