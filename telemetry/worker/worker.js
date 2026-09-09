export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") return new Response("ok");
  if (request.method !== "POST" || url.pathname !== "/v1/telemetry") return new Response("Not found", {status: 404});
  // Minimal forwarding on purpose: content-type + client IP only.
  // IPs are not hidden from the origin — the origin needs the real client IP
  // for per-IP rate-limiting. Nothing is stored; Cloudflare still sees the
  // source IP at the TLS/edge layer regardless of these headers.
  // All other client headers (User-Agent, Accept-Language, etc.) are dropped
  // so they cannot become fingerprinting signals beyond the JSON payload.
  const clientIp = request.headers.get("CF-Connecting-IP") || "";
  const contentType = request.headers.get("content-type") || "application/json";
  const headers = new Headers();
  headers.set("content-type", contentType);
  if (clientIp) {
    headers.set("CF-Connecting-IP", clientIp);
    headers.set("X-Forwarded-For", clientIp);
  }
  try { return await fetch(`${env.ORIGIN}/v1/telemetry`, {method:"POST", headers, body:request.body, signal:AbortSignal.timeout(5000)}); }
  catch { return new Response("Upstream unavailable", {status: 503}); }
} };
