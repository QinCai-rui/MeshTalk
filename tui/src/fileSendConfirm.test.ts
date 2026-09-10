import { describe, expect, test } from "bun:test"
import { mkdir, readFile, rm } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"
import {
  fileConfirmDialogHeight,
  fileConfirmImageBounds,
  hasImageConfirmationPreview,
  fileConfirmDialogWidth,
  fileTypeLabel,
  formatFileSize,
  parsePotentialFilePaths,
  stageFilesForConfirmation,
} from "./fileSendConfirm"

describe("file confirmation presentation", () => {
  test("uses a compact width and height for the confirmation popup", () => {
    expect(fileConfirmDialogWidth(120)).toBe(72)
    expect(fileConfirmDialogHeight(40, false)).toBe(12)
    expect(fileConfirmDialogHeight(40, true)).toBe(22)
  })

  test("keeps compact dimensions inside a narrow terminal", () => {
    expect(fileConfirmDialogWidth(42)).toBe(34)
    expect(fileConfirmDialogHeight(14, false)).toBe(8)
  })

  test("scales the confirmation preview to half the conversation image area", () => {
    expect(fileConfirmImageBounds(120, 40, 72, 30)).toEqual({ maxWidth: 68, maxHeight: 11 })
    expect(fileConfirmImageBounds(80, 20, 72, 18)).toEqual({ maxWidth: 53, maxHeight: 7 })
  })

  test("uses the image-sized confirmation dialog for a dropped image path", () => {
    expect(hasImageConfirmationPreview(["/tmp/meshtalk-drops/id/Screenshot.png"], false)).toBe(true)
    expect(hasImageConfirmationPreview(["/tmp/meshtalk-drops/id/notes.txt"], false)).toBe(false)
  })

  test("formats file sizes and identifies common file types", () => {
    expect(formatFileSize(850)).toBe("850 B")
    expect(formatFileSize(1536)).toBe("1.5 KiB")
    expect(formatFileSize(2 * 1024 * 1024)).toBe("2.0 MiB")
    expect(fileTypeLabel("photo.png")).toBe("image/png")
    expect(fileTypeLabel("notes.txt")).toBe("text/plain")
    expect(fileTypeLabel("archive.bin")).toBe("application/octet-stream")
  })

  test("preserves the MIME type supplied for pasted images", () => {
    expect(fileTypeLabel("pasted-image", "image/webp")).toBe("image/webp")
  })
})

test("stages dropped files in a stable temporary directory before confirmation", async () => {
  const directory = join(tmpdir(), `meshtalk-drop-source-${crypto.randomUUID()}`)
  const source = join(directory, "Screenshot.png")
  await mkdir(directory)
  await Bun.write(source, "image bytes")
  try {
    const [staged] = await stageFilesForConfirmation([source])
    await rm(source)
    expect(staged).toMatch(/meshtalk-drops\/[^/]+\/Screenshot\.png$/)
    expect(await readFile(staged!, "utf8")).toBe("image bytes")
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

describe("parsePotentialFilePaths", () => {
  test("parses a single absolute path", () => {
    expect(parsePotentialFilePaths("/home/you/file.txt")).toEqual(["/home/you/file.txt"])
  })

  test("parses file:// URLs with decoding", () => {
    expect(parsePotentialFilePaths("file:///home/you/my%20file.txt")).toEqual(["/home/you/my file.txt"])
  })

  test("parses quoted multi-path drops", () => {
    expect(parsePotentialFilePaths(`"/home/you/a b.txt" '/home/you/c.txt'`)).toEqual([
      "/home/you/a b.txt",
      "/home/you/c.txt",
    ])
  })

  test("parses newline-separated drops", () => {
    expect(parsePotentialFilePaths("/tmp/a.txt\n/tmp/b.txt")).toEqual(["/tmp/a.txt", "/tmp/b.txt"])
  })

  test("keeps windows paths", () => {
    expect(parsePotentialFilePaths("C:\\Users\\you\\file.txt")).toEqual(["C:\\Users\\you\\file.txt"])
  })

  test("ignores plain chat text", () => {
    expect(parsePotentialFilePaths("hello, how are you?")).toEqual([])
    expect(parsePotentialFilePaths("see /tmp/docs later maybe")).toEqual([])
    expect(parsePotentialFilePaths("/tmp/docs later maybe")).toEqual([])
  })

  test("skips non-path lines in multi-line pastes", () => {
    expect(parsePotentialFilePaths("/tmp/a.txt\njust chatting here")).toEqual(["/tmp/a.txt"])
  })
})
