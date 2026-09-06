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

export function shouldSuppressPastedImage(
  previous: PastedImageDedupRecord | undefined,
  next: PastedImageDedupRecord,
) {
  return Boolean(
    previous &&
      next.sentAt - previous.sentAt < PASTED_IMAGE_DEDUP_WINDOW_MS &&
      previous.selectionKey === next.selectionKey &&
      previous.byteLength === next.byteLength &&
      previous.hash === next.hash,
  );
}
