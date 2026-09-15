// Generates dist/sitemap.xml from pages.json.
// Indexable pages only (skips notFound, which is noindex).
// Usage: node sitemap.js
// Override the base domain: SITE_URL=https://your-domain.com node sitemap.js
const fs = require("fs");
const path = require("path");
const site = require("./pages.json");

const root = __dirname;
const public = path.join(root, "public");
const dist = path.join(root, "dist");
fs.mkdirSync(dist, { recursive: true });

const baseUrl = (process.env.SITE_URL || site.site.url || "").replace(/\/+$/, "");
const lastmod = new Date().toISOString().slice(0, 10);
const escapeXml = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const sitemapUrls = site.pages
  .filter((page) => page.canonical)
  .map((page) => {
    const loc = escapeXml(baseUrl + page.canonical);
    return `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`;
  })
  .join("\n");

const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapUrls}\n</urlset>\n`;

fs.writeFileSync(path.join(dist, "sitemap.xml"), sitemap);
fs.writeFileSync(path.join(public, "sitemap.xml"), sitemap);

console.log(
  `Wrote sitemap with ${site.pages.filter((p) => p.canonical).length} URLs into dist/ and public/`
);
