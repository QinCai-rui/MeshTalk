import { describe, expect, test } from "bun:test"
import { parsePotentialFilePaths } from "./fileSendConfirm"

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
