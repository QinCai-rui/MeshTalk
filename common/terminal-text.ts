// C0, DEL, and C1 controls, plus bidirectional formatting marks that can
// reorder how surrounding text is displayed.
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g

/** Encode terminal controls for display only. Never use this for storage, IPC, paths, or copying. */
export function terminalText(value: string, allowLayout = true): string {
  return value.replace(CONTROLS, (character) => {
    if (allowLayout && (character === "\n" || character === "\t")) return character
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  })
}
