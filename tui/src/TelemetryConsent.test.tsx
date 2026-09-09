import { test, expect } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelemetryConsent } from "./TelemetryConsent";
import { ChatApp } from "./ChatApp";

test("consent gates chat and requires confirmation before never asking again", async () => {
  const previous = process.env.MESHTALK_DATA_DIR;
  const directory = mkdtempSync(join(tmpdir(), "meshtalk-consent-"));
  process.env.MESHTALK_DATA_DIR = directory;
  const setup = await testRender(<ChatApp telemetryPrompt splashStyle={false} />, { width: 100, height: 40 });
  try {
    await act(async () => { await setup.renderOnce(); });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Enable extended telemetry");
    expect(frame).toContain("Enable basic telemetry");
    expect(frame).toContain("Keep telemetry off");
    expect(frame).toContain("Don't ask again");
    expect(frame).not.toContain("Enter send");
    await act(async () => { setup.mockInput.pressKey("\u0010"); await setup.renderOnce(); });
    expect(setup.captureCharFrame()).toContain("A LITTLE HELP");
    for (let i = 0; i < 3; i++) await act(async () => { setup.mockInput.pressTab(); });
    await act(async () => { setup.mockInput.pressEnter(); await setup.renderOnce(); });
    expect(setup.captureCharFrame()).toContain("Retire this little popup?");
    expect(setup.captureCharFrame()).toContain("Settings > Diagnostics");
    await act(async () => { setup.mockInput.pressEnter(); await setup.renderOnce(); });
    expect(setup.captureCharFrame()).toContain("Enable extended telemetry");
  } finally {
    await act(async () => { setup.renderer.destroy(); });
    if (previous === undefined) delete process.env.MESHTALK_DATA_DIR; else process.env.MESHTALK_DATA_DIR = previous;
  }
});

test("explicit never-ask confirmation persists off and never_ask_again", async () => {
  const previous = process.env.MESHTALK_DATA_DIR;
  const directory = mkdtempSync(join(tmpdir(), "meshtalk-consent-"));
  process.env.MESHTALK_DATA_DIR = directory;
  let finished = false;
  const setup = await testRender(<TelemetryConsent version="test" done={() => { finished = true; }} />, { width: 60, height: 24 });
  try {
    await act(async () => { await setup.renderOnce(); });
    for (let i = 0; i < 3; i++) await act(async () => { setup.mockInput.pressTab(); });
    await act(async () => { setup.mockInput.pressEnter(); await setup.renderOnce(); });
    expect(finished).toBe(false);
    await act(async () => { setup.mockInput.pressTab(); });
    await act(async () => { setup.mockInput.pressEnter(); });
    expect(finished).toBe(true);
    const settings = JSON.parse(readFileSync(join(directory, "settings.json"), "utf8"));
    expect(settings.telemetry_consent).toBe("never_ask_again");
    expect(settings.telemetry_level).toBe("off");
  } finally {
    await act(async () => { setup.renderer.destroy(); });
    if (previous === undefined) delete process.env.MESHTALK_DATA_DIR; else process.env.MESHTALK_DATA_DIR = previous;
  }
});
