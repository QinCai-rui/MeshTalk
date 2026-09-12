import { expect, test } from "bun:test";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";
import { HelpOverlay, HELP_SECTIONS, helpFocusFor, isHelpHotkey } from "./HelpOverlay";
import { ChatFooter } from "./ChatFooter";
import { DEFAULT_STATUS } from "../utils";

const noop = () => {};

async function settle(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => {
    await setup.flush();
    await setup.renderOnce();
  });
  return setup.captureCharFrame();
}

async function close(setup: Awaited<ReturnType<typeof testRender>>) {
  await act(async () => setup.renderer.destroy());
}

test("help hotkey matches Ctrl+/ and the 0x1F fallback", () => {
  expect(isHelpHotkey({ name: "/", ctrl: true, sequence: "/", raw: "/" })).toBe(true);
  expect(isHelpHotkey({ name: "/", ctrl: false, sequence: "/", raw: "/" })).toBe(false);
  expect(isHelpHotkey({ name: "p", ctrl: true, sequence: "\x10", raw: "\x10" })).toBe(false);
  expect(
    isHelpHotkey({ name: "unknown", ctrl: true, sequence: "\x1f", raw: "\x1f" }),
  ).toBe(true);
});

test("help focus derivation prefers dialog, naming, then history", () => {
  expect(
    helpFocusFor({ dialogOpen: true, editingName: true, scrollFocused: true }),
  ).toBe("dialog");
  expect(
    helpFocusFor({ dialogOpen: false, editingName: true, scrollFocused: true }),
  ).toBe("naming");
  expect(
    helpFocusFor({ dialogOpen: false, editingName: false, scrollFocused: true }),
  ).toBe("history");
  expect(
    helpFocusFor({ dialogOpen: false, editingName: false, scrollFocused: false }),
  ).toBe("composer");
});

test("help data covers the required shortcuts and groups", () => {
  const ids = HELP_SECTIONS.map((section) => section.id);
  for (const id of [
    "navigation",
    "composing",
    "history",
    "conversations",
    "files",
    "settings",
    "accessibility",
  ]) {
    expect(ids).toContain(id);
  }
  const corpus = HELP_SECTIONS.flatMap((section) => [
    section.title,
    ...section.shortcuts.flatMap((shortcut) => [shortcut.keys, shortcut.description]),
  ]).join("\n");
  for (const required of [
    "Enter",
    "Alt+Enter",
    "Ctrl+Up",
    "PgUp",
    "Ctrl+U",
    "Ctrl+P",
    "Esc",
    "Ctrl+/",
  ]) {
    expect(corpus).toContain(required);
  }
  // R reply and D delete are standalone rows so they stay discoverable.
  const historyKeys = HELP_SECTIONS.find((section) => section.id === "history")!.shortcuts.map(
    (shortcut) => shortcut.keys,
  );
  expect(historyKeys).toContain("R");
  expect(historyKeys).toContain("D");
});

test("help overlay renders the visible groups with a close affordance", async () => {
  const setup = await testRender(
    <HelpOverlay width={100} height={30} focus="composer" onClose={noop} />,
    { width: 100, height: 30 },
  );
  try {
    const frame = await settle(setup);
    expect(frame).toContain("Keyboard shortcuts");
    for (const title of ["Navigation", "Composing", "History"]) {
      expect(frame).toContain(title);
    }
    expect(frame).toContain("Relevant now: Composing");
    expect(frame).toContain("Enter — Send message");
    expect(frame).toContain("Esc / Ctrl+/ closes");
    expect(setup.renderer.root.findDescendantById("help-overlay")).toBeDefined();
    expect(setup.renderer.root.findDescendantById("help-close")).toBeDefined();
    expect(setup.renderer.root.findDescendantById("help-content")).toBeDefined();
    expect(HELP_SECTIONS.length).toBeGreaterThanOrEqual(7);
  } finally {
    await close(setup);
  }
});

test("help overlay highlights the relevant focus section", async () => {
  const setup = await testRender(
    <HelpOverlay width={100} height={30} focus="history" onClose={noop} />,
    { width: 100, height: 30 },
  );
  try {
    const frame = await settle(setup);
    expect(frame).toContain("Reading history");
    expect(frame.replace(/\s+/g, " ")).toContain("History — relevant now");
  } finally {
    await close(setup);
  }
});

for (const width of [64, 48, 32]) {
  test(`help overlay stays usable at ${width} columns`, async () => {
    const setup = await testRender(
      <HelpOverlay width={width} height={24} focus="composer" onClose={noop} />,
      { width, height: 24 },
    );
    try {
      const frame = await settle(setup);
      // Narrow widths clip long titles, so assert on tokens that survive wrapping.
      expect(frame).toContain("Keyboard");
      expect(frame).toContain("Close");
      expect(frame).toContain("Ctrl+/");
      expect(frame).toContain("closes");
      const overlay = setup.renderer.root.findDescendantById("help-overlay")!;
      expect(overlay).toBeDefined();
      expect(overlay.width).toBeLessThanOrEqual(width);
    } finally {
      await close(setup);
    }
  });
}

test("footer exposes a clickable help shortcut without removing settings", async () => {
  const setup = await testRender(
    <ChatFooter
      width={100}
      status={DEFAULT_STATUS}
      openSettings={noop}
      onOpenHelp={noop}
    />,
    { width: 100, height: 10 },
  );
  try {
    const frame = await settle(setup);
    expect(frame).toContain("Ctrl+P settings");
    expect(frame).toContain("Ctrl+/ help");
    expect(setup.renderer.root.findDescendantById("help-shortcut")).toBeDefined();
    expect(
      setup.renderer.root.findDescendantById("settings-shortcut"),
    ).toBeDefined();
  } finally {
    await close(setup);
  }
});

test("footer shows no mode hints — discovery lives in the help overlay", async () => {
  const setup = await testRender(
    <ChatFooter
      width={100}
      status={DEFAULT_STATUS}
      openSettings={noop}
      onOpenHelp={noop}
    />,
    { width: 100, height: 10 },
  );
  try {
    const frame = await settle(setup);
    for (const hint of [
      "Enter send",
      "PgUp history",
      "Ctrl+↑↓ chats",
      "Ctrl+U attach",
      "Drop files",
      "R reply",
      "D delete",
      "Esc compose",
    ]) {
      expect(frame).not.toContain(hint);
    }
    expect(setup.renderer.root.findDescendantById("help-shortcut")).toBeDefined();
  } finally {
    await close(setup);
  }
});

test("footer without a help handler keeps the legacy layout", async () => {
  const setup = await testRender(
    <ChatFooter
      width={100}
      status={DEFAULT_STATUS}
      openSettings={noop}
    />,
    { width: 100, height: 10 },
  );
  try {
    const frame = await settle(setup);
    expect(frame).toContain("Ctrl+P settings");
    expect(setup.renderer.root.findDescendantById("help-shortcut")).toBeUndefined();
  } finally {
    await close(setup);
  }
});
