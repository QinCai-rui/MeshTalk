import { NativeImage, type BoxRenderable, type ScrollBoxRenderable } from "@opentui/core"
import { useEffect, useRef, useState, type RefObject } from "react"
import { existsSync, statSync } from "fs"
import type { ImageProtocol } from "../types"
import { chatTheme as theme } from "../chatTheme"

type CachedImage = {
  modifiedAt: number
  original: NativeImage
  thumbnail: NativeImage
}

const MAX_CACHED_IMAGES = 48
const THUMBNAIL_MAX_SIDE = 640
const MAX_LOAD_RETRIES = 2
const LOAD_RETRY_DELAY_MS = 500
const IMAGE_BACKGROUND = [17, 25, 35, 255] as const
const cache = new Map<string, CachedImage>()

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

async function cachedImage(filePath: string): Promise<CachedImage | undefined> {
  if (!existsSync(filePath)) return undefined
  const modifiedAt = statSync(filePath).mtimeMs
  const existing = cache.get(filePath)
  if (existing?.modifiedAt === modifiedAt) {
    cache.delete(filePath)
    cache.set(filePath, existing)
    return existing
  }
  if (existing) {
    existing.original.dispose()
    existing.thumbnail.dispose()
    cache.delete(filePath)
  }
  const header = new Uint8Array(await Bun.file(filePath).slice(0, 16).arrayBuffer())
  if (!detectImageFormat(header)) return undefined
  const source = await NativeImage.load(filePath)
  const maxSide = Math.max(source.width, source.height)
  const original = opaqueImage(source)
  const thumbnail = maxSide > THUMBNAIL_MAX_SIDE
    ? source.resize(source.width >= source.height ? { width: THUMBNAIL_MAX_SIDE } : { height: THUMBNAIL_MAX_SIDE })
    : source.retain()
  source.dispose()
  const loaded = { modifiedAt, original, thumbnail }
  cache.set(filePath, loaded)
  while (cache.size > MAX_CACHED_IMAGES) {
    const oldest = cache.entries().next().value as [string, CachedImage] | undefined
    if (!oldest) break
    cache.delete(oldest[0])
    oldest[1].original.dispose()
    oldest[1].thumbnail.dispose()
  }
  return loaded
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
  const [nearViewport, setNearViewport] = useState(!lazy)
  const [fullyVisible, setFullyVisible] = useState(!scrollboxRef)
  const [image, setImage] = useState<NativeImage>()
  const [loadFailed, setLoadFailed] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)

  useEffect(() => {
    setNearViewport(!lazy)
    setFullyVisible(!scrollboxRef)
    setImage(undefined)
    setLoadFailed(false)
    setLoadAttempt(0)
  }, [filePath, fullSize, lazy])

  useEffect(() => {
    if (!lazy || nearViewport) return
    const checkViewport = () => {
      const node = containerRef.current
      const viewport = scrollboxRef?.current?.viewport
      if (!node || !viewport || node.height < 1) return
      const margin = viewport.height
      if (node.screenY + node.height > viewport.screenY - margin && node.screenY < viewport.screenY + viewport.height + margin) setNearViewport(true)
    }
    checkViewport()
    const interval = setInterval(checkViewport, 100)
    return () => clearInterval(interval)
  }, [lazy, nearViewport, scrollboxRef])

  useEffect(() => {
    if (!scrollboxRef) return
    const updateVisibility = () => {
      const node = containerRef.current
      const viewport = scrollboxRef.current?.viewport
      if (!node || !viewport || node.height < 1) return
      const next = isFullyWithinViewport(node, viewport)
      setFullyVisible((current) => current === next ? current : next)
    }
    updateVisibility()
    const interval = setInterval(updateVisibility, 32)
    return () => clearInterval(interval)
  }, [image, scrollboxRef])

  useEffect(() => {
    if (!nearViewport) return
    let cancelled = false
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    setLoadFailed(false)
    void cachedImage(filePath).then((loaded) => {
      if (cancelled) return
      if (loaded) {
        const source = fullSize ? loaded.original : loaded.thumbnail
        if (isImageDisposed(source)) {
          setLoadFailed(true)
          if (loadAttempt < MAX_LOAD_RETRIES) retryTimer = setTimeout(() => setLoadAttempt(loadAttempt + 1), LOAD_RETRY_DELAY_MS)
          return
        }
        setImage(retainImage(source))
        return
      }
      setLoadFailed(true)
      if (loadAttempt < MAX_LOAD_RETRIES) retryTimer = setTimeout(() => setLoadAttempt(loadAttempt + 1), LOAD_RETRY_DELAY_MS)
    }).catch(() => {
      if (cancelled) return
      setLoadFailed(true)
      if (loadAttempt < MAX_LOAD_RETRIES) retryTimer = setTimeout(() => setLoadAttempt(loadAttempt + 1), LOAD_RETRY_DELAY_MS)
    })
    return () => {
      cancelled = true
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [filePath, fullSize, nearViewport, loadAttempt])

  useEffect(() => {
    return () => {
      if (image) {
        try {
          if (!isImageDisposed(image)) image.dispose()
        } catch {}
      }
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
  // Kitty and Sixel placements are terminal overlays and cannot be scroll-clipped reliably.
  const displayProtocol = scrollboxRef && !fullyVisible && protocol !== "blocks" ? "blocks" : protocol
  return <box ref={containerRef} onMouseDown={(event) => { if (event.button === 0 && onOpen) { event.preventDefault(); event.stopPropagation(); onOpen() } }} style={{ flexDirection: "column", width: displayed?.width, height: displayed?.height }}>
    {!nearViewport && expectedImage ? <text fg={theme.muted}>{filename} (image preview loads nearby)</text> : null}
    {nearViewport && !safeImage && expectedImage ? <text fg={theme.muted}>{loadFailed ? `${filename} (image unavailable)` : "Loading image..."}</text> : null}
    {safeImage && displayed ? <image source={safeImage} fit="fit" protocol={displayProtocol} style={displayed} onMouseDown={(event) => { if (event.button === 0 && onOpen) { event.preventDefault(); event.stopPropagation(); onOpen() } }} /> : null}
  </box>
}
