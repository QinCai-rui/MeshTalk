/** Encode terminal controls for display only. Never use this for storage, IPC, paths, or copying. */
export function terminalText(value: string, allowLayout = true): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/g, (character) => {
    if (allowLayout && (character === "\n" || character === "\t")) return character
    return `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`
  })
}
