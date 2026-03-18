const express = require("express");
const axios = require("axios");
const { JSDOM } = require("jsdom");
const zlib = require("zlib");
const { URL } = require("url");

const app = express();

// ============================================================
// CONFIGURATION — Ganti sesuai kebutuhan
// ============================================================
const TARGET_HOSTNAME = "id.mgkomik.cc";
const TARGET_ORIGIN = `https://${TARGET_HOSTNAME}`;
// MIRROR_DOMAIN akan di-detect otomatis dari request, atau set manual:
const MANUAL_MIRROR_DOMAIN = ""; // Contoh: "mgkomik.qzz.io" (kosongkan untuk auto-detect)
const PORT = process.env.PORT || 3000;
const CACHE_TTL_SECONDS = 300; // 5 menit cache

// ============================================================
// IN-MEMORY CACHE (gunakan Redis untuk production besar)
// ============================================================
const cache = new Map();

function getCacheKey(url) {
  return url.replace(/\/$/, ""); // Normalize trailing slash
}

function getFromCache(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL_SECONDS * 1000) {
    cache.delete(key);
    return null;
  }
  return entry;
}

function setCache(key, data, contentType, statusCode) {
  // Limit cache size to prevent memory issues
  if (cache.size > 5000) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(key, {
    data,
    contentType,
    statusCode,
    timestamp: Date.now(),
  });
}

// ============================================================
// URL NORMALIZATION — Mencegah duplikat dari trailing slash
// ============================================================
app.use((req, res, next) => {
  const path = req.path;

  // Redirect trailing slash (kecuali root "/")
  if (path !== "/" && path.endsWith("/")) {
    const query = req.originalUrl.includes("?")
      ? req.originalUrl.substring(req.originalUrl.indexOf("?"))
      : "";
    return res.redirect(301, path.slice(0, -1) + query);
  }

  // Redirect uppercase URLs ke lowercase
  if (path !== path.toLowerCase()) {
    const query = req.originalUrl.includes("?")
      ? req.originalUrl.substring(req.originalUrl.indexOf("?"))
      : "";
    return res.redirect(301, path.toLowerCase() + query);
  }

  next();
});

// ============================================================
// CUSTOM ROBOTS.TXT — Penting untuk SEO mirror
// ============================================================
app.get("/robots.txt", (req, res) => {
  const mirrorDomain = MANUAL_MIRROR_DOMAIN || req.get("host");
  res.type("text/plain").send(
    `User-agent: *
Allow: /
Disallow: /wp-admin/
Disallow: /wp-login.php
Disallow: /*?s=
Disallow: /*?p=
Disallow: /tag/
Disallow: /author/
Disallow: /page/

Host: https://${mirrorDomain}
Sitemap: https://${mirrorDomain}/sitemap.xml
`
  );
});

// ============================================================
// HANDLE OPTIONS (CORS Preflight)
// ============================================================
app.options("*", (req, res) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "*",
  });
  res.sendStatus(204);
});

// ============================================================
// MAIN PROXY HANDLER
// ============================================================
app.all("*", async (req, res) => {
  try {
    const mirrorDomain = MANUAL_MIRROR_DOMAIN || req.get("host");
    const mirrorOrigin = `https://${mirrorDomain}`;

    // Build target URL
    const targetUrl = new URL(req.originalUrl, TARGET_ORIGIN);

    // Check cache for GET requests
    if (req.method === "GET") {
      const cacheKey = getCacheKey(targetUrl.toString());
      const cached = getFromCache(cacheKey);
      if (cached) {
        res.status(cached.statusCode);
        res.set("Content-Type", cached.contentType);
        res.set("X-Cache", "HIT");
        setCorsAndSeoHeaders(res, mirrorDomain);
        return res.send(cached.data);
      }
    }

    // Build headers to mimic browser
    const proxyHeaders = {
      Host: TARGET_HOSTNAME,
      "User-Agent":
        "Mozilla/5.0 (Linux; Android 10; SM-G973F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.9,id-ID;q=0.8",
      "Accept-Encoding": "gzip, deflate, br",
      Connection: "keep-alive",
      "Upgrade-Insecure-Requests": "1",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      "Sec-Fetch-Dest": "document",
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none",
      "Sec-Fetch-User": "?1",
      Referer: `${TARGET_ORIGIN}/`,
      DNT: "1",
      "Sec-Ch-Ua":
        '"Google Chrome";v="129", "Not=A?Brand";v="8", "Chromium";v="129"',
      "Sec-Ch-Ua-Mobile": "?1",
      "Sec-Ch-Ua-Platform": '"Android"',
    };

    // Fetch from target
    const response = await axios({
      method: req.method,
      url: targetUrl.toString(),
      headers: proxyHeaders,
      data: req.method !== "GET" ? req.body : undefined,
      responseType: "arraybuffer",
      maxRedirects: 5,
      validateStatus: () => true, // Accept all status codes
      timeout: 15000,
      decompress: true,
    });

    const contentType = response.headers["content-type"] || "";
    const statusCode = response.status;

    // Handle 403
    if (statusCode === 403) {
      return res
        .status(403)
        .send(
          "Target server denied access (403 Forbidden). Check anti-bot protections."
        );
    }

    // --------------------------------------------------------
    // HTML CONTENT — Full rewriting for SEO
    // --------------------------------------------------------
    if (contentType.includes("text/html")) {
      let html = response.data.toString("utf-8");

      // === DOMAIN REPLACEMENT (comprehensive) ===
      html = rewriteAllUrls(html, TARGET_HOSTNAME, mirrorDomain, mirrorOrigin);

      // === DOM-LEVEL SEO FIXES ===
      html = fixSeoWithDom(html, mirrorDomain, mirrorOrigin, req.originalUrl);

      // === REMOVE ADS ===
      html = removeAds(html);

      // Cache it
      if (req.method === "GET" && statusCode === 200) {
        setCache(
          getCacheKey(targetUrl.toString()),
          html,
          contentType,
          statusCode
        );
      }

      res.status(statusCode);
      res.set("Content-Type", contentType);
      res.set("X-Cache", "MISS");
      setCorsAndSeoHeaders(res, mirrorDomain);
      return res.send(html);
    }

    // --------------------------------------------------------
    // CSS CONTENT — Rewrite url() references
    // --------------------------------------------------------
    if (contentType.includes("text/css")) {
      let css = response.data.toString("utf-8");
      css = css.replace(
        new RegExp(escapeRegex(TARGET_HOSTNAME), "g"),
        mirrorDomain
      );

      res.status(statusCode);
      res.set("Content-Type", contentType);
      setCorsAndSeoHeaders(res, mirrorDomain);
      return res.send(css);
    }

    // --------------------------------------------------------
    // XML / SITEMAP / RSS — Rewrite URLs
    // --------------------------------------------------------
    if (
      contentType.includes("text/xml") ||
      contentType.includes("application/xml") ||
      contentType.includes("application/rss+xml") ||
      contentType.includes("application/atom+xml") ||
      req.originalUrl.includes("sitemap")
    ) {
      let xml = response.data.toString("utf-8");
      xml = xml.replace(
        new RegExp(`https?://${escapeRegex(TARGET_HOSTNAME)}`, "g"),
        mirrorOrigin
      );

      res.status(statusCode);
      res.set("Content-Type", contentType);
      setCorsAndSeoHeaders(res, mirrorDomain);
      return res.send(xml);
    }

    // --------------------------------------------------------
    // JSON (API, JSON-LD, etc.) — Rewrite URLs
    // --------------------------------------------------------
    if (contentType.includes("application/json")) {
      let json = response.data.toString("utf-8");
      json = json.replace(
        new RegExp(`https?://${escapeRegex(TARGET_HOSTNAME)}`, "g"),
        mirrorOrigin
      );
      json = json.replace(
        new RegExp(escapeRegex(TARGET_HOSTNAME), "g"),
        mirrorDomain
      );

      res.status(statusCode);
      res.set("Content-Type", contentType);
      setCorsAndSeoHeaders(res, mirrorDomain);
      return res.send(json);
    }

    // --------------------------------------------------------
    // JAVASCRIPT — Rewrite embedded URLs
    // --------------------------------------------------------
    if (
      contentType.includes("application/javascript") ||
      contentType.includes("text/javascript")
    ) {
      let js = response.data.toString("utf-8");
      js = js.replace(
        new RegExp(`https?://${escapeRegex(TARGET_HOSTNAME)}`, "g"),
        mirrorOrigin
      );
      js = js.replace(
        new RegExp(escapeRegex(TARGET_HOSTNAME), "g"),
        mirrorDomain
      );

      res.status(statusCode);
      res.set("Content-Type", contentType);
      setCorsAndSeoHeaders(res, mirrorDomain);
      return res.send(js);
    }

    // --------------------------------------------------------
    // BINARY / OTHER — Pass through
    // --------------------------------------------------------
    res.status(statusCode);
    res.set("Content-Type", contentType);
    setCorsAndSeoHeaders(res, mirrorDomain);

    // Pass through relevant headers
    const passHeaders = [
      "cache-control",
      "etag",
      "last-modified",
      "content-disposition",
    ];
    passHeaders.forEach((h) => {
      if (response.headers[h]) res.set(h, response.headers[h]);
    });

    return res.send(response.data);
  } catch (error) {
    console.error(`[PROXY ERROR] ${error.message}`);
    res.status(502).send(`Error fetching the website: ${error.message}`);
  }
});

// ============================================================
// HELPER: Comprehensive URL rewriting in HTML
// ============================================================
function rewriteAllUrls(html, targetHost, mirrorDomain, mirrorOrigin) {
  const escaped = escapeRegex(targetHost);

  // 1) Full URLs: http(s)://target → mirror
  html = html.replace(
    new RegExp(`https?://${escaped}`, "g"),
    mirrorOrigin
  );

  // 2) Protocol-relative: //target → //mirror
  html = html.replace(
    new RegExp(`//${escaped}`, "g"),
    `//${mirrorDomain}`
  );

  // 3) href="/ and src="/ → absolute mirror URLs
  html = html.replace(
    /(href|src|action|data-src|data-lazy-src|data-srcset|srcset)="\/(?!\/)/g,
    `$1="${mirrorOrigin}/`
  );
  html = html.replace(
    /(href|src|action|data-src|data-lazy-src|data-srcset|srcset)='\/(?!\/)/g,
    `$1='${mirrorOrigin}/`
  );

  // 4) Inline styles with url()
  html = html.replace(
    new RegExp(`url\\((['"]?)https?://${escaped}`, "g"),
    `url($1${mirrorOrigin}`
  );

  // 5) srcset attribute values (multiple URLs)
  html = html.replace(
    new RegExp(`${escaped}`, "g"),
    mirrorDomain
  );

  return html;
}

// ============================================================
// HELPER: DOM-level SEO fixing (canonical, meta, JSON-LD, etc.)
// ============================================================
function fixSeoWithDom(html, mirrorDomain, mirrorOrigin, requestPath) {
  const currentUrl = `${mirrorOrigin}${requestPath}`.replace(/\/$/, "");

  // ----------------------------------------------------------
  // 1) CANONICAL TAG — Paling penting untuk anti-duplikat!
  // ----------------------------------------------------------
  // Remove existing canonical
  html = html.replace(/<link[^>]*rel=["']canonical["'][^>]*\/?>/gi, "");

  // Remove existing og:url
  html = html.replace(
    /<meta[^>]*property=["']og:url["'][^>]*\/?>/gi,
    ""
  );

  // Remove existing alternate/hreflang
  html = html.replace(
    /<link[^>]*rel=["']alternate["'][^>]*\/?>/gi,
    ""
  );

  // Build canonical + OG block
  const seoBlock = `
    <!-- Mirror SEO Tags - Auto Generated -->
    <link rel="canonical" href="${currentUrl}" />
    <meta property="og:url" content="${currentUrl}" />
    <meta property="og:site_name" content="${mirrorDomain}" />
    <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1" />
    <link rel="alternate" hreflang="id" href="${currentUrl}" />
    <link rel="alternate" hreflang="x-default" href="${currentUrl}" />
  `;

  // Inject after <head>
  html = html.replace(/<head([^>]*)>/i, `<head$1>${seoBlock}`);

  // ----------------------------------------------------------
  // 2) FIX JSON-LD (Structured Data / Schema.org)
  // ----------------------------------------------------------
  html = html.replace(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    (match, jsonContent) => {
      try {
        let data = JSON.parse(jsonContent);
        data = rewriteJsonLd(data, TARGET_HOSTNAME, mirrorDomain, mirrorOrigin);
        return `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
      } catch (e) {
        // If JSON parse fails, just do string replacement
        let fixed = jsonContent.replace(
          new RegExp(escapeRegex(TARGET_HOSTNAME), "g"),
          mirrorDomain
        );
        return `<script type="application/ld+json">${fixed}</script>`;
      }
    }
  );

  // ----------------------------------------------------------
  // 3) FIX <meta> tags (description, twitter, etc.)
  // ----------------------------------------------------------
  html = html.replace(
    new RegExp(
      `(<meta[^>]*content=["'])https?://${escapeRegex(TARGET_HOSTNAME)}`,
      "gi"
    ),
    `$1${mirrorOrigin}`
  );

  // ----------------------------------------------------------
  // 4) REMOVE DUPLICATE TITLE TAGS (keep only first)
  // ----------------------------------------------------------
  let titleCount = 0;
  html = html.replace(/<title[^>]*>[\s\S]*?<\/title>/gi, (match) => {
    titleCount++;
    return titleCount === 1 ? match : "";
  });

  // ----------------------------------------------------------
  // 5) REMOVE DUPLICATE META DESCRIPTIONS (keep only first)
  // ----------------------------------------------------------
  let descCount = 0;
  html = html.replace(
    /<meta[^>]*name=["']description["'][^>]*\/?>/gi,
    (match) => {
      descCount++;
      return descCount === 1 ? match : "";
    }
  );

  return html;
}

// ============================================================
// HELPER: Recursively fix JSON-LD structured data
// ============================================================
function rewriteJsonLd(obj, targetHost, mirrorDomain, mirrorOrigin) {
  if (typeof obj === "string") {
    return obj
      .replace(new RegExp(`https?://${escapeRegex(targetHost)}`, "g"), mirrorOrigin)
      .replace(new RegExp(escapeRegex(targetHost), "g"), mirrorDomain);
  }
  if (Array.isArray(obj)) {
    return obj.map((item) =>
      rewriteJsonLd(item, targetHost, mirrorDomain, mirrorOrigin)
    );
  }
  if (typeof obj === "object" && obj !== null) {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = rewriteJsonLd(value, targetHost, mirrorDomain, mirrorOrigin);
    }
    return result;
  }
  return obj;
}

// ============================================================
// HELPER: Remove ad blocks
// ============================================================
function removeAds(html) {
  const adPatterns = [
    /<div[^>]*class="[^"]*ad[^"]*c-ads[^"]*custom-code[^"]*body-top-ads[^"]*"[\s\S]*?<\/div>/gi,
    /<div[^>]*id="floating_ads_bottom_textcss_close"[\s\S]*?<\/div>/gi,
    /<div[^>]*id="floating_ads_bottom_textcss_container"[\s\S]*?<\/div>/gi,
    /<div[^>]*class="[^"]*mgid[^"]*"[\s\S]*?<\/div>/gi,
    /<ins[^>]*class="[^"]*adsbygoogle[^"]*"[\s\S]*?<\/ins>/gi,
    /<script[^>]*>[\s\S]*?adsbygoogle[\s\S]*?<\/script>/gi,
    /<script[^>]*src="[^"]*doubleclick[^"]*"[^>]*><\/script>/gi,
    /<script[^>]*src="[^"]*googlesyndication[^"]*"[^>]*><\/script>/gi,
    /<div[^>]*class="[^"]*iklan[^"]*"[\s\S]*?<\/div>/gi,
    /<div[^>]*id="[^"]*iklan[^"]*"[\s\S]*?<\/div>/gi,
  ];

  adPatterns.forEach((pattern) => {
    html = html.replace(pattern, "<!-- ad removed -->");
  });

  return html;
}

// ============================================================
// HELPER: Set CORS and SEO response headers
// ============================================================
function setCorsAndSeoHeaders(res, mirrorDomain) {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.set("Access-Control-Allow-Headers", "*");
  res.set("X-Robots-Tag", "index, follow");
  res.set("Vary", "User-Agent, Accept-Encoding");

  // Remove headers that could cause issues
  res.removeHeader("x-frame-options");
  res.removeHeader("content-security-policy");
}

// ============================================================
// HELPER: Escape regex special characters
// ============================================================
function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, () => {
  console.log(`🚀 Mirror proxy running on port ${PORT}`);
  console.log(`📡 Target: ${TARGET_ORIGIN}`);
  console.log(`💡 Mirror domain: ${MANUAL_MIRROR_DOMAIN || "(auto-detect from request)"}`);
});