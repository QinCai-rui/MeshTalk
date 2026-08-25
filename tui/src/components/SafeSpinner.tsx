import { useEffect, useState } from "react"

let spinnerRegistered = false
let registerAttempted = false
let registerPromise: Promise<boolean> | null = null

function ensureSpinner(): Promise<boolean> {
  if (registerAttempted && registerPromise) return registerPromise
  registerAttempted = true
  registerPromise = import("opentui-spinner/react")
    .then(() => {
      spinnerRegistered = true
      return true
    })
    .catch(() => false)
  return registerPromise
}

// Try eager registration at module load (best-effort, non-blocking for bundle)
void ensureSpinner().catch(() => {})

function FallbackDots({ color }: { color?: string }) {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % 3), 350)
    return () => clearInterval(id)
  }, [])
  const dots = [".  ", ".. ", "..."][frame]
  return <text fg={color ?? "#7aa2d6"}>{dots}</text>
}

export function SafeSpinner({ color = "#7aa2d6", name = "simpleDotsScrolling" }: { color?: string; name?: string }) {
  const [ready, setReady] = useState(spinnerRegistered)

  useEffect(() => {
    if (spinnerRegistered) {
      setReady(true)
      return
    }
    let cancelled = false
    void ensureSpinner().then((ok) => {
      if (!cancelled) setReady(ok && spinnerRegistered)
    })
    return () => {
      cancelled = true
    }
  }, [])

  if (ready) {
    // spinner is registered globally via opentui-spinner/react side-effect
    // @ts-ignore - JSX intrinsic element provided by spinner plugin
    return <spinner name={name as never} color={color} />
  }
  return <FallbackDots color={color} />
}
