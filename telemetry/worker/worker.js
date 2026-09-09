export default { async fetch(request, env) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") return new Response("ok");
  if (request.method !== "POST" || url.pathname !== "/v1/telemetry") return new Response("Not found", {status: 404});
  const headers = new Headers(request.headers); headers.delete("CF-Connecting-IP"); headers.delete("X-Forwarded-For");
  try { return await fetch(`${env.ORIGIN}/v1/telemetry`, {method:"POST", headers, body:request.body, signal:AbortSignal.timeout(5000)}); }
  catch { return new Response("Upstream unavailable", {status: 503}); }
} };
