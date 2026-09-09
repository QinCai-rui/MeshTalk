import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import { useRef, useState } from "react";
import type { ScrollBoxRenderable } from "@opentui/core";
import { PRIVACY_URL, markPrompted, writeConsent, writeLevel, type TelemetryLevel } from "../../common/telemetry";
import { chatTheme as theme } from "./chatTheme";

export function TelemetryConsent({ version, done }: { version: string; done: () => void }) {
  const { width, height } = useTerminalDimensions();
  const [selected, setSelected] = useState(0);
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState("");
  const saving = useRef(false);
  const selectedRef = useRef(0);
  const confirmRef = useRef(false);
  const scroll = useRef<ScrollBoxRenderable>(null);
  const compact = width < 60;
  const cardWidth = Math.max(24, Math.min(86, width - 4));
  const mainChoices = [
    { label: "Enable extended telemetry", detail: "Version + aggregate usage and stability counters", value: "extended", size: 2 },
    { label: "Enable basic telemetry", detail: "Version, operating system and architecture only", value: "basic", size: 1 },
    { label: "Keep telemetry off", detail: "Do not send telemetry. You can change this later in Settings > Diagnostics.", value: "off", size: 0 },
    { label: "Don't ask again", detail: "", value: "confirm", size: 0 },
  ];
  const confirmChoices = [
    { label: "Go back", detail: "Show my sharing options", value: "back", size: 1 },
    { label: "Yes, don't ask again", detail: "Keep telemetry off", value: "never", size: 0 },
  ];
  const choices = confirm ? confirmChoices : mainChoices;
  const selectIndex = (index: number) => { selectedRef.current = index; setSelected(index); };
  const setConfirmMode = (value: boolean) => { confirmRef.current = value; setConfirm(value); };
  function activate(index: number) {
    const currentChoices = confirmRef.current ? confirmChoices : mainChoices;
    const value = currentChoices[index]?.value;
    if (!value || saving.current) return;
    if (value === "confirm" || value === "back") {
      setConfirmMode(value === "confirm"); selectIndex(0); setError(""); return;
    }
    saving.current = true;
    try {
      writeLevel(value === "never" ? "off" : value as TelemetryLevel);
      if (value === "never") writeConsent("never_ask_again");
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
    if (key.name === "escape" && confirmRef.current) { setConfirmMode(false); selectIndex(3); return; }
    let next = selectedRef.current;
    if (key.name === "up" || key.name === "k" || (key.name === "tab" && key.shift)) next = (selectedRef.current + currentChoices.length - 1) % currentChoices.length;
    else if (key.name === "down" || key.name === "j" || key.name === "tab") next = (selectedRef.current + 1) % currentChoices.length;
    else if (key.name === "return" || key.name === "linefeed" || key.name === "space") { activate(selectedRef.current); return; }
    selectIndex(next);
    scroll.current?.scrollChildIntoView("consent-" + next);
  });
  return <box width="100%" height="100%" backgroundColor="#090f1b" alignItems="center" justifyContent="center"
    onMouseDown={event => { event.preventDefault(); event.stopPropagation(); }}>
    <box width={cardWidth} height={Math.min(Math.max(confirm ? 22 : 36, height - 2), confirm ? 26 : 42)} border borderColor="#799be8" backgroundColor="#151e31" flexDirection="column" paddingX={compact ? 1 : 3} paddingY={1}>
      <scrollbox ref={scroll} flexGrow={1} minHeight={0} contentOptions={{ flexDirection: "column", gap: 1 }}>
        <text fg="#9bb7ff">✦  A LITTLE HELP FOR THE MESH</text>
        <text fg={theme.text}><b>{confirm ? "Retire this little popup?" : "Help us squash bugs. Not your conversations."}</b></text>
        <text fg={theme.muted} wrapMode="word">{confirm
          ? "Telemetry will stay off and we won't ask again, even after updates. You can turn it back on anytime in Settings > Diagnostics. No awkward reunion required."
          : "A few anonymous counters help us spot connection hiccups and learn what gets used. Less guessing for us, a smoother MeshTalk for everyone."}</text>
        {!confirm && <text fg="#a9bde1" wrapMode="word">Optional. Off until you choose. No chat content, filenames, identities or stored IPs in telemetry.</text>}
        {!confirm && <text fg={theme.accent}>Extended gives us the most useful clues. Thank you!</text>}
        {choices.map((choice, index) => choice.value === "confirm" ? <box key={choice.value} id={"consent-" + index} width="100%" height={2} flexShrink={0} alignItems="center" justifyContent="center" onMouseMove={() => setSelected(index)} onMouseDown={event => { event.stopPropagation(); if (event.button === 0) activate(index); }}>
          <text fg={selected === index ? theme.muted : theme.subdued}><span>{selected === index ? "›  " : "    "}</span><u>Don't ask again</u></text>
        </box> : <box key={choice.value} id={"consent-" + index}
          width={compact ? "100%" : choice.value === "extended" || choice.value === "basic" ? "88%" : "78%"}
          alignSelf="center" height={choice.value === "extended" ? 6 : choice.value === "basic" ? 4 : 5} flexShrink={0}
          border borderColor={selected === index ? choice.value === "off" ? "#65738a" : "#bad0ff" : choice.value === "extended" ? "#4e9d91" : "#405273"}
          backgroundColor={choice.value === "extended" ? "#264c59" : selected === index ? choice.value === "off" ? "#202a3b" : "#293a59" : "#1b2941"}
          alignItems="center" justifyContent="center" flexDirection="column" paddingX={2}
          onMouseDown={event => { event.stopPropagation(); if (event.button === 0) activate(index); }}
          onMouseMove={() => setSelected(index)}>
          <text fg={choice.value === "extended" ? "#b7f7df" : choice.value === "off" ? theme.muted : theme.text}><b>{selected === index ? "› " : "  "}{choice.label}</b></text>
          {choice.detail && !compact && <text fg={choice.value === "off" ? theme.subdued : "#b4c7db"}>{choice.detail}</text>}
        </box>)}
        {!confirm && <text fg={theme.link} wrapMode="word">Privacy policy: {PRIVACY_URL}</text>}
        {error && <text fg={theme.danger}>{error}</text>}
      </scrollbox>
      <text fg={theme.muted} flexShrink={0} wrapMode="word">↑↓ / Tab select · Enter confirm · Click to choose</text>
    </box>
  </box>;
}
