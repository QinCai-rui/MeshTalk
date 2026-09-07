import { NativeImage, type BoxRenderable, type ScrollBoxRenderable } from "@opentui/core"
import { useEffect, useRef, useState, type RefObject } from "react"
import { existsSync, statSync } from "fs"
import type { ImageProtocol } from "../types"
import { chatTheme as theme } from "../chatTheme"

type CachedImage = {
  modifiedAt: number
  thumbnail: NativeImage
  bytes: number
}

const MAX_THUMBNAIL_CACHE_BYTES = 32 * 1024 * 1024
const THUMBNAIL_MAX_SIDE = 640
const IMAGE_BACKGROUND = [17, 25, 35, 255] as const
const UNLOAD_CONFIRM_DELAY_MS = 150
const cache = new Map<string, CachedImage>()
let cachedThumbnailBytes = 0
const pendingThumbnailLoads = new Map<string, Promise<NativeImage | undefined>>()
const viewportListeners = new Set<() => void>()
let viewportNotificationQueued = false

export function notifyImageViewportChanged() {
  if (viewportNotificationQueued) return
  viewportNotificationQueued = true
  queueMicrotask(() => {
    viewportNotificationQueued = false
    for (const listener of [...viewportListeners]) listener()
  })
}

export function detectImageFormat(bytes: Uint8Array): "png" | "jpeg" | "webp" | "gif" | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "png"
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg"
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "gif"
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "webp"
  return undefined
}

export function fittedImageSize(imageWidth: number, imageHeight: number, maxWidth: number, maxHeight: number): { width: number; height: number } {
  const widthLimit = Math.max(1, Math.floor(maxWidth))
  const heightLimit = Math.max(1, Math.floor(maxHeight))
  const aspect = imageHeight / imageWidth
  const width = Math.max(1, Math.min(widthLimit, Math.floor(heightLimit * 2 / aspect)))
  return { width, height: Math.max(1, Math.min(heightLimit, Math.ceil(width * aspect / 2))) }
}

export function isLocalFileMissing(filePath: string | null | undefined): boolean {
  return !filePath || !existsSync(filePath)
}

export function isFullyWithinViewport(node: Pick<BoxRenderable, "screenY" | "height">, viewport: Pick<BoxRenderable, "screenY" | "height">): boolean {
  return node.screenY >= viewport.screenY && node.screenY + node.height <= viewport.screenY + viewport.height
}

function isImageDisposed(image: NativeImage): boolean {
  try {
    void image.width
    return false
  } catch {
    return true
  }
}

function retainImage(image: NativeImage): NativeImage {
  try {
    return image.retain()
  } catch {
    return image
  }
}

function opaqueImage(image: NativeImage): NativeImage {
  if (!image.info().hasAlpha) return image.retain()
  const pixels = new Uint8Array(image.width * image.height * 4)
  for (let offset = 0; offset < pixels.length; offset += 4) pixels.set(IMAGE_BACKGROUND, offset)
  const background = NativeImage.fromRgba(pixels, image.width, image.height)
  try {
    return background.composite(image)
  } finally {
    background.dispose()
  }
}

function disposeImage(image: NativeImage | undefined) {
  if (!image || isImageDisposed(image)) return
  try { image.dispose() } catch {}
}

function removeCachedImage(filePath: string) {
  const cached = cache.get(filePath)
  if (!cached) return
  cache.delete(filePath)
  cachedThumbnailBytes -= cached.bytes
  disposeImage(cached.thumbnail)
}

export function clearImageCache() {
  pendingThumbnailLoads.clear()
  for (const filePath of [...cache.keys()]) removeCachedImage(filePath)
}

async function loadCachedThumbnail(filePath: string): Promise<NativeImage | undefined> {
  if (!existsSync(filePath)) return undefined
  const modifiedAt = statSync(filePath).mtimeMs
  const existing = cache.get(filePath)
  if (existing?.modifiedAt === modifiedAt) {
    cache.delete(filePath)
    cache.set(filePath, existing)
    return existing.thumbnail
  }
  if (existing) removeCachedImage(filePath)
  const header = new Uint8Array(await Bun.file(filePath).slice(0, 16).arrayBuffer())
  if (!detectImageFormat(header)) return undefined
  const source = await NativeImage.load(filePath)
  const resized = Math.max(source.width, source.height) > THUMBNAIL_MAX_SIDE
    ? source.resize(source.width >= source.height ? { width: THUMBNAIL_MAX_SIDE } : { height: THUMBNAIL_MAX_SIDE })
    : source.retain()
  const thumbnail = opaqueImage(resized)
  resized.dispose()
  source.dispose()
  const loaded = { modifiedAt, thumbnail, bytes: thumbnail.width * thumbnail.height * 4 }
  // Several attachment rows can reference the same file. If they raced while
  // decoding, keep only the newest cached handle and release the duplicate.
  const latest = cache.get(filePath)
  if (latest) {
    if (latest.modifiedAt === modifiedAt) {
      disposeImage(loaded.thumbnail)
      return latest.thumbnail
    }
    removeCachedImage(filePath)
  }
  cache.set(filePath, loaded)
  cachedThumbnailBytes += loaded.bytes
  while (cachedThumbnailBytes > MAX_THUMBNAIL_CACHE_BYTES) {
    const oldest = cache.entries().next().value as [string, CachedImage] | undefined
    if (!oldest) break
    removeCachedImage(oldest[0])
  }
  return cache.get(filePath)?.thumbnail
}

async function cachedThumbnail(filePath: string): Promise<NativeImage | undefined> {
  const pending = pendingThumbnailLoads.get(filePath)
  if (pending) return pending
  const load = loadCachedThumbnail(filePath)
  pendingThumbnailLoads.set(filePath, load)
  try {
    return await load
  } finally {
    if (pendingThumbnailLoads.get(filePath) === load) pendingThumbnailLoads.delete(filePath)
  }
}

async function loadImage(filePath: string, fullSize: boolean) {
  if (!fullSize) return cachedThumbnail(filePath)
  if (!existsSync(filePath)) return undefined
  const header = new Uint8Array(await Bun.file(filePath).slice(0, 16).arrayBuffer())
  if (!detectImageFormat(header)) return undefined
  const source = await NativeImage.load(filePath)
  try {
    return opaqueImage(source)
  } finally {
    source.dispose()
  }
}

type ImageAttachmentProps = {
  filePath: string
  filename: string
  protocol: ImageProtocol
  expectedImage?: boolean
  fullSize?: boolean
  lazy?: boolean
  scrollboxRef?: RefObject<ScrollBoxRenderable | null>
  maxWidth: number
  maxHeight: number
  onOpen?: () => void
}

export function ImageAttachment({ filePath, filename, protocol, expectedImage = false, fullSize = false, lazy = true, scrollboxRef, maxWidth, maxHeight, onOpen }: ImageAttachmentProps) {
  const containerRef = useRef<BoxRenderable>(null)
  const viewportCheckRef = useRef<(deferUnload?: boolean) => void>(() => {})
  const nearViewportRef = useRef(!lazy)
  const unloadTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [nearViewport, setNearViewport] = useState(!lazy)
  const [image, setImage] = useState<NativeImage>()
  const [intrinsicSize, setIntrinsicSize] = useState<{ width: number; height: number }>()
  const [reservedSize, setReservedSize] = useState<{ width: number; height: number }>()
  const [loadFailed, setLoadFailed] = useState(false)

  useEffect(() => {
    if (unloadTimerRef.current) clearTimeout(unloadTimerRef.current)
    unloadTimerRef.current = undefined
    nearViewportRef.current = !lazy
    setNearViewport(!lazy)
    setImage(undefined)
    setIntrinsicSize(undefined)
    setReservedSize(undefined)
    setLoadFailed(false)
  }, [filePath, fullSize, lazy, protocol])

  nearViewportRef.current = nearViewport
  viewportCheckRef.current = (deferUnload = true) => {
    const node = containerRef.current
    const viewport = scrollboxRef?.current?.viewport
    if (!node || !viewport || node.height < 1) return
    // The visible viewport plus one quarter above and below is 1.5 viewports.
    // Load at 1.5 viewports, but keep a loaded image until it is a little
    // farther away. This prevents boundary flicker while dragging quickly.
    const margin = Math.ceil(viewport.height * (nearViewport ? 0.5 : 0.25))
    const nearby = !lazy || (node.screenY + node.height > viewport.screenY - margin && node.screenY < viewport.screenY + viewport.height + margin)
    if (nearby) {
      if (unloadTimerRef.current) clearTimeout(unloadTimerRef.current)
      unloadTimerRef.current = undefined
      nearViewportRef.current = true
      setNearViewport((current) => current === true ? current : true)
      return
    }
    if (!nearViewportRef.current) return
    if (deferUnload) {
      if (unloadTimerRef.current) return
      unloadTimerRef.current = setTimeout(() => {
        unloadTimerRef.current = undefined
        viewportCheckRef.current(false)
      }, UNLOAD_CONFIRM_DELAY_MS)
      return
    }
    nearViewportRef.current = false
    setNearViewport((current) => current === false ? current : false)
  }

  useEffect(() => {
    const listener = () => viewportCheckRef.current()
    viewportListeners.add(listener)
    listener()
    return () => {
      viewportListeners.delete(listener)
    }
  }, [])

  useEffect(() => {
    return () => {
      if (unloadTimerRef.current) clearTimeout(unloadTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (!nearViewport) setImage(undefined)
  }, [nearViewport])

  useEffect(() => {
    if (!nearViewport) return
    let cancelled = false
    setLoadFailed(false)
    void loadImage(filePath, fullSize).then((loaded) => {
      // Full-size loads return a new handle owned by this component. A
      // thumbnail comes from the shared cache and must not be disposed here.
      if (cancelled) {
        if (fullSize) disposeImage(loaded)
        return
      }
      if (loaded) {
        if (isImageDisposed(loaded)) {
          setLoadFailed(true)
          return
        }
        setIntrinsicSize({ width: loaded.width, height: loaded.height })
        setReservedSize(fittedImageSize(loaded.width, loaded.height, maxWidth, maxHeight))
        setImage(fullSize ? loaded : retainImage(loaded))
        return
      }
      setLoadFailed(true)
    }).catch(() => {
      if (cancelled) return
      setLoadFailed(true)
    })
    return () => {
      cancelled = true
    }
  }, [filePath, fullSize, nearViewport, protocol])

  // Keep the placeholder geometry correct when the terminal is resized while
  // this image is unloaded. The native source may be gone, so retain only its
  // dimensions rather than another image handle.
  useEffect(() => {
    if (!intrinsicSize) return
    setReservedSize(fittedImageSize(intrinsicSize.width, intrinsicSize.height, maxWidth, maxHeight))
  }, [intrinsicSize, maxWidth, maxHeight])

  useEffect(() => {
    return () => {
      disposeImage(image)
    }
  }, [image])

  const safeImage = image && !isImageDisposed(image) ? image : undefined
  const displayed = (() => {
    if (!safeImage) return undefined
    try {
      return fittedImageSize(safeImage.width, safeImage.height, maxWidth, maxHeight)
    } catch {
      return undefined
    }
  })()
  const layoutSize = displayed ?? reservedSize
  const displayProtocol = protocol
  const placeholderText = expectedImage
    ? !nearViewport
      ? `${filename} (image preview loads nearby)`
      : !safeImage
        ? loadFailed ? `${filename} (image unavailable)` : "Loading image..."
        : undefined
    : undefined
  const placeholderTop = layoutSize ? Math.max(0, Math.floor((layoutSize.height - 1) / 2)) : 0
  return <box ref={containerRef} onSizeChange={notifyImageViewportChanged} onMouseDown={(event) => { if (event.button === 0 && onOpen) { event.preventDefault(); event.stopPropagation(); onOpen() } }} style={{ flexDirection: "column", width: layoutSize?.width, height: layoutSize?.height, minHeight: layoutSize ? undefined : 1 }}>
    {/* Keep the renderable identity and reserved geometry stable while its
        native source is released. This avoids a Kitty placement being
        destroyed and recreated when an adjacent row crosses the viewport. */}
    {layoutSize ? <image source={safeImage} fit="fit" protocol={displayProtocol} style={layoutSize} onMouseDown={(event) => { if (event.button === 0 && onOpen) { event.preventDefault(); event.stopPropagation(); onOpen() } }} /> : null}
    {!layoutSize && placeholderText ? <text fg={theme.muted}>{placeholderText}</text> : null}
    {layoutSize && placeholderText ? <text position="absolute" left={0} top={placeholderTop} width={layoutSize.width} fg={theme.muted}>{placeholderText}</text> : null}
  </box>
}
