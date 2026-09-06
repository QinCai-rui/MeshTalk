export const PASTED_IMAGE_DEDUP_WINDOW_MS = 750;

export type PastedImageDedupRecord = {
  byteLength: number;
  hash: bigint;
  selectionKey?: string;
  sentAt: number;
};

export function createPastedImageDedupRecord(
  bytes: Uint8Array,
  selectionKey: string | undefined,
  sentAt: number,
): PastedImageDedupRecord {
  return {
    byteLength: bytes.byteLength,
    hash: Bun.hash.wyhash(bytes),
    selectionKey,
    sentAt,
  };
}

// A 64-bit hash makes a collision vanishingly unlikely while avoiding retention
// and comparison of image buffers that can be up to 8 MiB.
export function shouldSuppressPastedImage(
  previous: PastedImageDedupRecord | undefined,
  next: PastedImageDedupRecord,
) {
  return Boolean(
    previous &&
      next.selectionKey &&
      next.sentAt - previous.sentAt >= 0 &&
      next.sentAt - previous.sentAt < PASTED_IMAGE_DEDUP_WINDOW_MS &&
      previous.selectionKey === next.selectionKey &&
      previous.byteLength === next.byteLength &&
      previous.hash === next.hash,
  );
}
