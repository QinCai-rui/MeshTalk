import { expect, test } from "bun:test"
import { isMuteActive } from "./utils"

test("treats only permanent and unexpired mutes as active", () => {
  const now = 1_000
  expect(isMuteActive(undefined, now)).toBe(false)
  expect(isMuteActive(0, now)).toBe(true)
  expect(isMuteActive(1_001, now)).toBe(true)
  expect(isMuteActive(1_000, now)).toBe(false)
})
