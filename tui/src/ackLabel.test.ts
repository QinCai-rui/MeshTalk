import { expect, test } from "bun:test";
import { ackLabel } from "./utils";

test("ackLabel returns undefined with no ackers", () => {
  expect(ackLabel([])).toBeUndefined();
});

test("ackLabel names one and two ackers", () => {
  expect(ackLabel(["Alice"])).toBe("✓ Acknowledged by Alice");
  expect(ackLabel(["Alice", "Bob"])).toBe("✓ Acknowledged by Alice, Bob");
});

test("ackLabel truncates three or more ackers", () => {
  expect(ackLabel(["Alice", "Bob", "Carol"])).toBe("✓ Acknowledged by Alice, Bob +1");
  expect(ackLabel(["Alice", "Bob", "Carol", "Dan"])).toBe("✓ Acknowledged by Alice, Bob +2");
});

test("ackLabel ignores blank names", () => {
  expect(ackLabel(["  ", "Alice"])).toBe("✓ Acknowledged by Alice");
});
