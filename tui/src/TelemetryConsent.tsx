import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useRef, useState } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { PRIVACY_URL, markPrompted, writeConsent, writeLevel, type TelemetryLevel } from "../../common/telemetry";
import { chatTheme as theme } from "./chatTheme";

type Choice = { label: string; detail: string; value: string };

export function TelemetryConsent({ version, done }: { version: string; done: () => void }) {
  const { width, height } = useTerminalDimensions();
  const [selected, setSelected] = useState(2);
  const [confirm, setConfirm] = useState(false);
  const [neverAskAgain, setNeverAskAgain] = useState(false);
  const [error, setError] = useState("");
  const saving = useRef(false);
  const selectedRef = useRef(2);
  const confirmRef = useRef(false);
  const neverAskAgainRef = useRef(false);
  const scroll = useRef<ScrollBoxRenderable>(null);
  const compact = width < 72;
  const cardWidth = Math.max(24, Math.min(86, width - 4));
  const mainChoices: Choice[] = [
    { label: "Enable extended telemetry", detail: "Version + room/group/transport counters (no message or file activity)", value: "extended" },
    { label: "Enable basic telemetry", detail: "Version, operating system and architecture only", value: "basic" },
    { label: "Keep telemetry off", detail: "Off by default", value: "off" },
  ];
  const confirmChoices: Choice[] = [
    { label: "Go back — Re-review your privacy options", detail: "", value: "back" },
    { label: "Keep telemetry off", detail: "", value: "keep" },
    { label: "Don't ask again", detail: "", value: "toggle" },
  ];
  const choices = confirm ? confirmChoices : mainChoices;
  const selectIndex = (index: number) => { selectedRef.current = index; setSelected(index); };
  const setConfirmMode = (value: boolean) => { confirmRef.current = value; setConfirm(value); };

  function activate(index: number) {
    const currentChoices = confirmRef.current ? confirmChoices : mainChoices;
    const value = currentChoices[index]?.value;
    if (!value || saving.current) return;
    if (value === "off") { setConfirmMode(true); selectIndex(1); neverAskAgainRef.current = false; setNeverAskAgain(false); setError(""); return; }
    if (value === "toggle") { neverAskAgainRef.current = !neverAskAgainRef.current; setNeverAskAgain(neverAskAgainRef.current); return; }
    if (value === "back") { setConfirmMode(false); selectIndex(2); setError(""); return; }
    saving.current = true;
    try {
      writeLevel(value === "keep" ? "off" : value as TelemetryLevel);
      if (value === "keep" && neverAskAgainRef.current) writeConsent("never_ask_again");
      markPrompted(version);
      done();
    } catch {
      setError("Couldn't save your choice. Please try again.");
      saving.current = false;
    }
  }

  useKeyboard(key => {
    key.preventDefault();
    if (key.ctrl || key.meta || key.super) return;
    const currentChoices = confirmRef.current ? confirmChoices : mainChoices;
    if (key.name === "escape" && confirmRef.current) { setConfirmMode(false); selectIndex(2); return; }
    let next = selectedRef.current;
    if (key.name === "up" || key.name === "k" || (key.name === "tab" && key.shift)) next = (selectedRef.current + currentChoices.length - 1) % currentChoices.length;
    else if (key.name === "down" || key.name === "j" || key.name === "tab") next = (selectedRef.current + 1) % currentChoices.length;
    else if (key.name === "return" || key.name === "linefeed") { activate(selectedRef.current); return; }
    else if (key.name === "space") { if (confirmRef.current && currentChoices[selectedRef.current]?.value === "toggle") { neverAskAgainRef.current = !neverAskAgainRef.current; setNeverAskAgain(neverAskAgainRef.current); } else activate(selectedRef.current); return; }
    selectIndex(next);
    scroll.current?.scrollChildIntoView("consent-" + next);
  });

  const cardHeight = Math.min(Math.max(confirm ? 22 : 36, height - 2), confirm ? 26 : 42);
  const blockPointer = (event: { preventDefault: () => void; stopPropagation: () => void }) => { event.preventDefault(); event.stopPropagation(); };
  return <box width="100%" height="100%" backgroundColor="#090f1b" alignItems="center" justifyContent="center" onMouseDown={blockPointer} onMouseUp={blockPointer}>
    <box width={cardWidth} height={cardHeight} border borderColor="#799be8" backgroundColor="#151e31" flexDirection="column" paddingX={compact ? 1 : 3} paddingY={1}>
      <scrollbox ref={scroll} flexGrow={1} minHeight={0} contentOptions={{ flexDirection: "column", gap: confirm ? 0 : 1 }} verticalScrollbarOptions={{ visible: false }}>
        <text fg="#9bb7ff">✦  A LITTLE HELP FOR THE MESH</text>
        {confirm && <box height={1} flexShrink={0} />}
        <text fg={theme.text}><b>{confirm ? "Keep telemetry off?" : "Help us squash bugs. Not your conversations."}</b></text>
        {confirm && <box height={1} flexShrink={0} />}
        <text fg={theme.muted} wrapMode="word">{confirm
          ? "We respect that you may prefer not to share telemetry. You can re-enable it anytime in Settings > Diagnostics."
          : "A few anonymous counters help us spot connection hiccups and learn what people actually use. Less guessing for us, a smoother MeshTalk for everyone."}</text>
        {!confirm && <text fg="#a9bde1" wrapMode="word">Optional and off by default. No chat content, filenames, identities, or message/file activity. IPs are visible transiently for delivery and rate-limiting, never stored.</text>}
        {!confirm && <text fg={theme.accent}>Off is the default. Extended is optional and can be changed anytime.</text>}
        {confirm && <box height={1} flexShrink={0} />}
        {choices.map((choice, index) => <box key={choice.value} flexDirection="column" flexShrink={0}>
          {choice.value === "toggle" ? <box id={"consent-" + index} width="100%" height={2} flexShrink={0} alignItems="center" justifyContent="center" onMouseMove={() => selectIndex(index)} onMouseDown={event => { event.stopPropagation(); if (event.button === 0) { neverAskAgainRef.current = !neverAskAgainRef.current; setNeverAskAgain(neverAskAgainRef.current); } }}>
            <text fg={selected === index ? theme.muted : theme.subdued}><span>{selected === index ? "›  " : "   "}{neverAskAgain ? "[✓] " : "[ ] "}</span><u>Don't ask again</u></text>
          </box> : <box id={"consent-" + index}
            width={compact ? "100%" : confirm ? choice.value === "back" ? "82%" : "68%" : choice.value === "extended" || choice.value === "basic" ? "88%" : "78%"}
            alignSelf="center" height={confirm ? choice.value === "back" ? 5 : choice.value === "keep" ? 3 : 2 : choice.value === "extended" ? 6 : choice.value === "basic" ? 4 : 4} flexShrink={0}
            border borderColor={selected === index ? choice.value === "off" ? "#65738a" : choice.value === "keep" ? "#d8954d" : "#bad0ff" : choice.value === "extended" ? "#4e9d91" : choice.value === "keep" ? "#7b5937" : "#405273"}
            backgroundColor={choice.value === "extended" ? "#264c59" : choice.value === "keep" ? selected === index ? "#3a2d22" : "#252633" : selected === index ? choice.value === "off" ? "#202a3b" : "#293a59" : "#1b2941"}
            alignItems="center" justifyContent="center" flexDirection="column" paddingX={2}
            onMouseDown={event => { event.stopPropagation(); if (event.button === 0) activate(index); }} onMouseMove={() => selectIndex(index)}>
            <text fg={choice.value === "extended" ? "#b7f7df" : choice.value === "off" ? theme.muted : choice.value === "keep" ? "#f0bd7c" : theme.text}><b>{selected === index ? "› " : "  "}{choice.label}</b></text>
            {choice.detail && (!compact || choice.value === "back") && <text fg={choice.value === "off" ? theme.subdued : "#b4c7db"} wrapMode={choice.value === "back" ? "none" : "word"}>{choice.detail}</text>}
          </box>}
          {confirm && index < choices.length - 1 && <box height={1} flexShrink={0} />}
        </box>)}
        {!confirm && <text fg={theme.link} wrapMode="word">Privacy policy: {PRIVACY_URL}</text>}
        {error && <text fg={theme.danger}>{error}</text>}
      </scrollbox>
      <text fg={theme.muted} flexShrink={0} wrapMode="word">↑↓ / Tab select · Enter confirm · Space checks box · Click to choose</text>
    </box>
  </box>;
}
