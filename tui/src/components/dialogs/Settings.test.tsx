import { test, expect } from "bun:test"
import { act, useState } from "react"
import { testRender } from "@opentui/react/test-utils"
import { SettingsPanel } from "./SettingsPanel"
import { SettingsLanding } from "./CommandDialogs"
import { CustomisationDialogContent } from "./PreferenceDialogs"
import type { Dialog } from "../../types"
import { SettingsField, SettingsConfirm } from "./SettingsPrimitives"
import { MouseSelect } from "../MouseSelect"
import { dialogUsesTextInput } from "../../navigation"
import { DialogPanel } from "../DialogPanel"
import type { ComponentProps } from "react"

for (const [width, height] of [[96, 28], [60, 20], [32, 12]]) {
  test(`settings category navigation fits ${width}x${height}`, async () => {
    let command = ""
    function Harness() {
      const [dialog, setDialog] = useState<Dialog>({ kind: "settings" })
      const run = (value: string) => { command = value; if (value === "customisation") setDialog({ kind: "customisation" }) }
      return <box width={width} height={height}>
        <SettingsPanel dialog={dialog} width={width} height={height} busy={false} error="" runCommand={run} goBack={() => {}}>
          {dialog.kind === "settings" ? <SettingsLanding dialogHeight={height - 4} /> : <CustomisationDialogContent dialogHeight={height - 4} splashStyle="off" showDialog={setDialog} />}
        </SettingsPanel>
      </box>
    }
    const setup = await testRender(<Harness />, { width, height })
    try {
      await act(async () => { await setup.renderOnce() })
      expect(setup.captureCharFrame()).toContain("Settings")
      await act(async () => { setup.mockInput.pressTab(); await setup.renderOnce() })
      await act(async () => { setup.mockInput.pressArrow("down"); await setup.renderOnce() })
      await act(async () => { setup.mockInput.pressArrow("down"); await setup.renderOnce() })
      await act(async () => { setup.mockInput.pressEnter(); await setup.renderOnce() })
      expect(command).toBe("customisation")
      await act(async () => { await setup.renderOnce() })
      expect(setup.captureCharFrame()).toContain("Splash screen")
    } finally { await act(async () => { setup.renderer.destroy() }) }
  })
}

test("category focus preserves an edited field and Backspace remains an editing key", async () => {
  let saved = ""
  function Harness() {
    const [draft, setDraft] = useState("Taylor")
    return <SettingsPanel dialog={{ kind: "rename" }} width={48} height={18} busy={false} error="" runCommand={() => {}} goBack={() => {}}>
      <SettingsField label="Display name" description="Visible to peers" value={draft} placeholder="Name" maxLength={48} onInput={setDraft} onSubmit={value => { saved = value }} />
    </SettingsPanel>
  }
  const setup = await testRender(<Harness />, { width: 48, height: 18 })
  try {
    await act(async () => { await setup.renderOnce(); setup.mockInput.pressBackspace() })
    await act(async () => { setup.mockInput.pressTab(); await setup.renderOnce() })
    await act(async () => { setup.mockInput.pressTab(); await setup.renderOnce() })
    await act(async () => { setup.mockInput.pressEnter() })
    expect(saved).toBe("Taylo")
    expect(dialogUsesTextInput({ kind: "rename" })).toBe(true)
    expect(dialogUsesTextInput({ kind: "settings" })).toBe(false)
  } finally { await act(async () => { setup.renderer.destroy() }) }
})

test("destructive confirmation starts on Cancel and only confirms after an explicit selection", async () => {
  let confirmed = 0
  let cancelled = 0
  const setup = await testRender(<SettingsConfirm question="Remove friend?" detail="Future messages will be blocked." confirmLabel="Remove" destructive onConfirm={() => confirmed++} onCancel={() => cancelled++} />, { width: 48, height: 14 })
  try {
    await act(async () => { await setup.renderOnce(); setup.mockInput.pressEnter() })
    expect(confirmed).toBe(0)
    expect(cancelled).toBe(1)
    await act(async () => { setup.mockInput.pressArrow("up") })
    await act(async () => { setup.mockInput.pressEnter() })
    expect(confirmed).toBe(1)
  } finally { await act(async () => { setup.renderer.destroy() }) }
})

test("long help is scrollable and a shortened option list retains a valid selection", async () => {
  let shorten = () => {}
  let selected = ""
  function Harness() {
    const [short, setShort] = useState(false)
    shorten = () => setShort(true)
    return <MouseSelect focused height={8} descriptionMode="panel" options={(short ? ["one"] : ["one", "two", "three"]).map(value => ({ name: value, value, description: "Long guidance ".repeat(60) + "END OF HELP" }))} onSelect={(_, option) => { selected = option?.value }} />
  }
  const setup = await testRender(<Harness />, { width: 32, height: 8 })
  try {
    await act(async () => { await setup.renderOnce(); setup.mockInput.pressKey("\u001b[F") })
    await act(async () => { shorten(); await setup.renderOnce() })
    await act(async () => { setup.mockInput.pressEnter() })
    expect(selected).toBe("one")
    for (let i = 0; i < 20; i++) await act(async () => { setup.mockInput.pressKey("\u001b[6~"); await setup.renderOnce() })
    expect(setup.captureCharFrame()).toContain("END OF HELP")
  } finally { await act(async () => { setup.renderer.destroy() }) }
})

for (const dialog of [
  { kind: "settings" },
  { kind: "advanced", config: { image_protocol: "auto", splash_style: "off", control_pinned_ips: [], stun_pinned_ips: [], stun_server: "stun.example" } },
  { kind: "notification-enable", firstRun: true },
] as Dialog[]) {
  test(`integrated ${dialog.kind} panel remains within its centered dialog`, async () => {
    const props = {
      dialog, dialogBusy: false, dialogError: "", dialogHeight: 28, dialogWidth: 100, dialogDraft: "",
      groups: [], peers: [], mutedPeers: {}, controlStatus: { connected: false, reconnect_attempts: 0 },
      imageProtocol: "auto", splashStyle: "off", appReleaseVersion: "test", isReleaseBuild: false,
      dialogWidthFor: () => 100, runCommand: () => {}, goBack: () => {},
    } as unknown as ComponentProps<typeof DialogPanel>
    const setup = await testRender(<DialogPanel {...props} />, { width: 120, height: 36 })
    try {
      await act(async () => { await setup.renderOnce() })
      const panel = setup.renderer.root.findDescendantById("settings-panel")!
      expect(panel.screenX).toBeGreaterThan(0)
      expect(panel.screenY).toBeGreaterThan(0)
      expect(panel.screenX + panel.width).toBeLessThan(120)
      expect(panel.screenY + panel.height).toBeLessThan(36)
      expect(setup.captureCharFrame()).toContain(dialog.kind === "settings" ? "Control server" : dialog.kind === "advanced" ? "Image protocol" : "Enable and test")
      if ("firstRun" in dialog) expect(setup.renderer.root.findDescendantById("settings-categories")).toBeUndefined()
    } finally { await act(async () => { setup.renderer.destroy() }) }
  })
}
