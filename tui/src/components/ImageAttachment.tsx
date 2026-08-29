import { NativeImage, type BoxRenderable, type ScrollBoxRenderable } from "@opentui/core"
import { useEffect, useRef, useState, type RefObject } from "react"
import { existsSync, statSync } from "fs"
import type { ImageProtocol } from "../types"

type CachedImage = {
  modifiedAt: number
  original: NativeImage
  thumbnail: NativeImage
}

const MAX_CACHED_IMAGES = 48
const THUMBNAIL_MAX_SIDE = 640
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
  const original = await NativeImage.load(filePath)
  const maxSide = Math.max(original.width, original.height)
  const thumbnail = maxSide > THUMBNAIL_MAX_SIDE
    ? original.resize(original.width >= original.height ? { width: THUMBNAIL_MAX_SIDE } : { height: THUMBNAIL_MAX_SIDE })
    : original.retain()
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
  const [image, setImage] = useState<NativeImage>()

  useEffect(() => {
    setNearViewport(!lazy)
    setImage(undefined)
  }, [filePath, lazy])

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
    if (!nearViewport) return
    let cancelled = false
    void cachedImage(filePath).then((loaded) => {
      if (cancelled) return
      if (!loaded) return
      setImage(fullSize ? loaded.original : loaded.thumbnail)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [filePath, fullSize, nearViewport, expectedImage])

  const displayed = image ? fittedImageSize(image.width, image.height, maxWidth, maxHeight) : undefined
  return <box ref={containerRef} onMouseDown={(event) => { if (event.button === 0 && onOpen) { event.preventDefault(); event.stopPropagation(); onOpen() } }} style={{ flexDirection: "column", width: displayed?.width, height: displayed?.height }}>
    {!nearViewport && expectedImage ? <text fg="#888888">{filename} (image preview loads nearby)</text> : null}
    {nearViewport && !image && expectedImage ? <text fg="#888888">Loading image...</text> : null}
    {image && displayed ? <image source={image} fit="fit" protocol={protocol} style={displayed} onMouseDown={(event) => { if (event.button === 0 && onOpen) { event.preventDefault(); event.stopPropagation(); onOpen() } }} /> : null}
  </box>
}
