import { MouseSelect } from "../MouseSelect"
import { MarqueeText } from "../MarqueeText"
import { releaseInstallDir } from "../../../../common/updater"
import { resolve } from "path"
import type { Dialog } from "../../types"
import { chatTheme as theme } from "../../chatTheme"

type SettingsLandingProps = {
  dialogHeight: number
}

export function SettingsLanding({ dialogHeight: _dialogHeight }: SettingsLandingProps) {
  return <box style={{ width: "100%", height: "100%", flexGrow: 1, justifyContent: "center", alignItems: "center", padding: 2 }}>
      <box style={{ maxWidth: 48, flexDirection: "column", gap: 1 }}>
        <text fg={theme.accent}><b>Choose a settings section</b></text>
        <text fg={theme.text} wrapMode="word">Select a panel in the category rail to open its page.</text>
        <text fg={theme.muted} wrapMode="word">On narrow terminals, press Tab to open the category list.</text>
        <text fg={theme.subdued} wrapMode="word">Files & transfers opens the full-screen transfer manager.</text>
      </box>
    </box>
}

type AboutDialogProps = {
  appReleaseVersion: string
  dialog: Extract<Dialog, { kind: "about" }>
  dialogError: string
  dialogHeight: number
  dialogWidth: number
  isReleaseBuild: boolean
  checkForUpdates: () => void
  goBack: () => void
}

export function AboutDialog({ appReleaseVersion, dialog, dialogError, dialogHeight, dialogWidth, isReleaseBuild, checkForUpdates, goBack }: AboutDialogProps) {
  return <box style={{ flexDirection: "column", gap: 1, backgroundColor: theme.surfaceRaised, width: "100%", height: "100%" }}>
    <text><span fg={theme.accent}><b>MeshTalk</b></span> <span fg={theme.muted}>terminal messenger</span></text>
    <text><span fg={theme.link}>Version </span><span fg={theme.success}><b>{appReleaseVersion}</b></span></text>
    <text><span fg={theme.warning}>Made with love</span> <span fg={theme.muted}>by </span><span fg={theme.accent}>Raymont</span><span fg={theme.muted}>, </span><span fg={theme.link}>Kaesar, </span>and contributors.</text>
     <text fg={theme.subdued}>Fully decentralised</text>
     <text fg={theme.subdued}>Private by architecture • Not by policy</text>
    {dialog.checked && <MarqueeText width={dialogWidth - 4} fg={isReleaseBuild ? theme.success : theme.danger} text={isReleaseBuild ? "You are up to date, or release metadata is unavailable." : "Updates are available only in compiled MeshTalk releases."} />}
    {dialogError && <text fg={theme.danger}>{dialogError}</text>}
    <MouseSelect focused height={Math.max(3, dialogHeight - 7)} options={[
      { name: dialog.checking ? "Checking for updates..." : "Check for updates", description: isReleaseBuild ? "Look for the latest stable MeshTalk release" : "Available in compiled MeshTalk releases", value: "check" },
      { name: "Back", description: "Return to Settings", value: "back" },
    ]} onSelect={(_, option) => {
      if (option?.value === "check" && !dialog.checking) checkForUpdates()
      else if (option?.value === "back") goBack()
    }} wrapSelection showDescription />
  </box>
}

type UpdateDialogProps = {
  appReleaseVersion: string
  dialog: Extract<Dialog, { kind: "update" }>
  dialogError: string
  dialogHeight: number
  dialogWidth: number
  closeDialog: () => void
  installing: boolean
  installUpdate: (release: Extract<Dialog, { kind: "update" }>["release"], destination?: string) => void
  restartUpdate: (installDir: string) => void
  chooseUpdateDestination: (release: Extract<Dialog, { kind: "update" }>["release"]) => void
}

function progressLabel(progress: NonNullable<Extract<Dialog, { kind: "update" }>["progress"]>): string {
  const phase = `[${progress.current}/${progress.total}] ${progress.step}`
  if (progress.receivedBytes === undefined) return phase
  const received = (progress.receivedBytes / 1024 / 1024).toFixed(1)
  if (!progress.totalBytes) return `${phase}: ${received} MiB`
  return `${phase}: ${Math.floor(progress.receivedBytes / progress.totalBytes * 100)}% (${received} MiB / ${(progress.totalBytes / 1024 / 1024).toFixed(1)} MiB)`
}

export function UpdateDialog({ appReleaseVersion, dialog, dialogError, dialogHeight, dialogWidth, closeDialog, installing, installUpdate, restartUpdate, chooseUpdateDestination }: UpdateDialogProps) {
  return <>
    <text><b>{dialog.installed ? `MeshTalk ${dialog.release.version} is ready.` : `MeshTalk ${dialog.release.version} is available.`}</b></text>
    {!dialog.installed && <text fg={theme.muted}>Installed version: {appReleaseVersion}</text>}
    {installing ? <box style={{ flexDirection: "row", alignItems: "center", gap: 1 }}><spinner name="material" color={theme.warning} /><text fg={theme.warning}>{progressLabel(dialog.progress ?? { current: 1, total: 6, step: "Preparing update" })}</text></box> : dialog.installed ? <MarqueeText width={dialogWidth - 4} fg={theme.success} text="Update installed. Restart now to use the new version, or dismiss to keep this session running." /> : <MarqueeText width={dialogWidth - 4} fg={theme.muted} text="The download will be verified with GitHub's SHA-256 digest before installation." />}
    {dialogError && <text fg={theme.danger}>{dialogError}</text>}
    {!installing && <MouseSelect focused height={Math.max(3, dialogHeight - 7)} options={dialog.installed ? [
      { name: "Restart now", description: "Close MeshTalk, stop the backend, and launch the updated installation", value: "restart" },
      { name: "Dismiss", description: "Continue using the current MeshTalk session", value: "dismiss" },
    ] : [
      { name: "Install now", description: "Download and install while MeshTalk remains open", value: "install" },
      { name: "Install to another folder", description: "Choose another existing MeshTalk installation", value: "destination" },
      { name: "Ignore", description: "Ask again the next time MeshTalk starts", value: "ignore" },
    ]} onSelect={(_, option) => {
      if (option?.value === "install") installUpdate(dialog.release)
      else if (option?.value === "destination") chooseUpdateDestination(dialog.release)
      else if (option?.value === "restart" && dialog.installDir) restartUpdate(dialog.installDir)
      else if (option?.value === "ignore" || option?.value === "dismiss") closeDialog()
    }} wrapSelection showDescription />}
    {!installing && !dialog.installed && (() => {
      const dir = dialog.installDir ?? releaseInstallDir()
      return dir ? <text fg={theme.subdued}>  {resolve(dir)}</text> : null
    })()}
  </>
}

export function UpdateTokenDialog({ dialog, dialogError, dialogDraft, setDialogDraft, saveUpdateToken }: { dialog: Extract<Dialog, { kind: "update-token" }>; dialogError: string; dialogDraft: string; setDialogDraft: (value: string) => void; saveUpdateToken: (release: Extract<Dialog, { kind: "update" }>["release"] | undefined, destination: string | undefined, token: string) => void }) {
  return <box style={{ flexDirection: "column", gap: 1 }}>
    <text>GitHub denied access to MeshTalk{dialog.release ? ` ${dialog.release.version}` : " releases"}.</text>
    <text fg={theme.muted}>Enter a token with repository access. It is stored unencrypted in ~/.meshtalk/settings.json.</text>
    {dialogError && <text fg={theme.danger}>{dialogError}</text>}
    <input focused value={dialogDraft} placeholder="GitHub token" onInput={setDialogDraft} onSubmit={(value) => saveUpdateToken(dialog.release, dialog.destination, typeof value === "string" ? value : dialogDraft)} maxLength={4096} />
  </box>
}

export function UpdateDestinationDialog({ dialog, dialogError, dialogWidth, dialogDraft, setDialogDraft, installUpdate }: { dialog: Extract<Dialog, { kind: "update-directory" }>; dialogError: string; dialogWidth: number; dialogDraft: string; setDialogDraft: (value: string) => void; installUpdate: (release: Extract<Dialog, { kind: "update" }>["release"], destination?: string) => void }) {
  return <box style={{ flexDirection: "column", gap: 1 }}>
    <text>Install MeshTalk {dialog.release.version} into an existing installation folder.</text>
    <MarqueeText width={dialogWidth - 4} fg={theme.muted} text="The folder must contain meshtalk, meshtalk-backend, meshtalk-cli, and meshtalk-tui." />
    {dialogError && <text fg={theme.danger}>{dialogError}</text>}
    <input focused value={dialogDraft} placeholder="/path/to/MeshTalk" onInput={setDialogDraft} onSubmit={(value) => installUpdate(dialog.release, typeof value === "string" ? value : dialogDraft)} maxLength={4096} />
    {dialogDraft.trim() ? <text fg={theme.subdued}>  {resolve(dialogDraft.trim())}</text> : null}
  </box>
}
