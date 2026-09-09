import { test, expect } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnalyticsConsent } from "./AnalyticsConsent";
import { ChatApp } from "./ChatApp";

test("consent gates chat and hides never-ask from the main menu", async () => {
  const previous = process.env.MESHTALK_DATA_DIR;
  const directory = mkdtempSync(join(tmpdir(), "meshtalk-consent-"));
  process.env.MESHTALK_DATA_DIR = directory;
  const setup = await testRender(<ChatApp analyticsPrompt splashStyle={false} />, { width: 100, height: 40 });
  try {
    await act(async () => { await setup.renderOnce(); });
    const frame = setup.captureCharFrame();
    expect(frame).toContain("Enable extended analytics");
    expect(frame).toContain("Enable basic analytics");
    expect(frame).toContain("Keep analytics off");
    expect(frame).not.toContain("[ ] Don't ask again");
    expect(frame).not.toContain("Enter send");
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
  const setup = await testRender(<AnalyticsConsent version="test" done={() => { finished = true; }} />, { width: 60, height: 32 });
  try {
    await act(async () => { await setup.renderOnce(); });
    // Nothing is preselected; Up wraps to "Keep analytics off", Enter opens confirm.
    await act(async () => { setup.mockInput.pressArrow("up"); });
    await act(async () => { await setup.renderOnce(); });
    await act(async () => { setup.mockInput.pressEnter(); });
    await act(async () => { await setup.renderOnce(); });
    expect(finished).toBe(false);
    const confirmationFrame = setup.captureCharFrame();
    expect(confirmationFrame).toContain("Keep analytics off?");
    expect(confirmationFrame).toContain("Don't ask again");
    expect(confirmationFrame).toContain("Go back");
    expect(confirmationFrame).toContain("Re-review your privacy options");
    expect(confirmationFrame).not.toContain("Analyticsystays");
    await act(async () => { setup.mockInput.pressArrow("up"); setup.mockInput.pressKey(" "); setup.mockInput.pressArrow("down"); setup.mockInput.pressArrow("down"); });
    await act(async () => { setup.mockInput.pressEnter(); });
    expect(finished).toBe(true);
    const settings = JSON.parse(readFileSync(join(directory, "settings.json"), "utf8"));
    expect(settings.analytics_consent).toBe("never_ask_again");
    expect(settings.analytics_level).toBe("off");
  } finally {
    await act(async () => { setup.renderer.destroy(); });
    if (previous === undefined) delete process.env.MESHTALK_DATA_DIR; else process.env.MESHTALK_DATA_DIR = previous;
  }
});
