import { expect, test } from "bun:test";
import {
  createPastedImageDedupRecord,
  PASTED_IMAGE_DEDUP_WINDOW_MS,
  shouldSuppressPastedImage,
} from "./pastedImageDedup";

const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

test("suppresses the same pasted image in the same conversation during the dedup window", () => {
  const previous = createPastedImageDedupRecord(image, "peer:alice", 100);
  const next = createPastedImageDedupRecord(image, "peer:alice", 200);

  expect(shouldSuppressPastedImage(previous, next)).toBe(true);
});

test("allows images with different bytes or a different destination", () => {
  const previous = createPastedImageDedupRecord(image, "peer:alice", 100);

  expect(
    shouldSuppressPastedImage(
      previous,
      createPastedImageDedupRecord(new Uint8Array([0xff, 0xd8, 0xff]), "peer:alice", 200),
    ),
  ).toBe(false);
  expect(
    shouldSuppressPastedImage(
      previous,
      createPastedImageDedupRecord(image, "group:alice", 200),
    ),
  ).toBe(false);
});

test("allows the same image after the dedup window", () => {
  const previous = createPastedImageDedupRecord(image, "peer:alice", 100);
  const next = createPastedImageDedupRecord(
    image,
    "peer:alice",
    100 + PASTED_IMAGE_DEDUP_WINDOW_MS,
  );

  expect(shouldSuppressPastedImage(previous, next)).toBe(false);
});
