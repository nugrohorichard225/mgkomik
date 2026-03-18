const express = require("express");
const axios = require("axios");
const { JSDOM } = require("jsdom");
const { URL } = require("url");
const { execFile } = require("child_process");
const path = require("path");

const app = express();

// ============================================================
// CONFIGURATION
// ============================================================
const TARGET_HOSTNAME = "id.mgkomik.cc";
const TARGET_ORIGIN = `https://${TARGET_HOSTNAME}`;
const MANUAL_MIRROR_DOMAIN = "";
const PORT = process.env.PORT || 3000;
const CACHE_TTL_SECONDS = 300;

// Cloudflare cookie refresh interval (25 menit, sebelum expired ~30 menit)
const CF_COOKIE_REFRESH_MS = 25 * 60 * 1000;
// Max wait for Cloudflare challenge to solve
const CF_SOLVE_TIMEOUT_MS = 60000;
// Cooldown setelah solve gagal (60 detik) — prevent infinite retry
const CF_SOLVE_COOLDOWN_MS = 60000;
let lastSolveFailTime = 0;

// ============================================================
// IN-MEMORY CACHE
// ============================================================
const cache = new Map();

function getCacheKey(url) {
  return url.replace(/\/$/, "");
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
// CLOUDFLARE BYPASS — Python botasaurus-driver approach
// Uses proven botasaurus-driver CDP implementation for CF solving
// ============================================================

let cfCookies = "";
let cfUserAgent = "";
let cfCookieTimestamp = 0;
let isSolvingCF = false;
let solvePromise = null;

/**
 * Solve Cloudflare challenge using Python botasaurus-driver
 * This calls cf_solver.py which uses the proven botasaurus CDP browser
 * with shadow root Turnstile solving
 */
async function solveCloudflareCookies() {
  // Prevent multiple simultaneous solves
  if (isSolvingCF && solvePromise) {
    return solvePromise;
  }

  // Cooldown to prevent infinite retry storms
  if (lastSolveFailTime && Date.now() - lastSolveFailTime < CF_SOLVE_COOLDOWN_MS) {
    console.log("[CF BYPASS] In cooldown period, skipping solve attempt");
    return { cookies: cfCookies, userAgent: cfUserAgent };
  }

  isSolvingCF = true;
  solvePromise = (async () => {
    console.log("[CF BYPASS] Starting botasaurus-driver Python solver...");

    try {
      const result = await runPythonSolver(TARGET_ORIGIN);

      if (result.success && result.cookieString) {
        console.log(`[CF BYPASS] SUCCESS! Got cookies: ${Object.keys(result.cookies).join(", ")}`);
        console.log(`[CF BYPASS] Page title: ${result.title}`);
        cfCookies = result.cookieString;
        cfUserAgent = result.userAgent;
        cfCookieTimestamp = Date.now();
        lastSolveFailTime = 0;
        return { cookies: cfCookies, userAgent: cfUserAgent };
      } else {
        const errMsg = result.error || "No cookies obtained";
        console.error(`[CF BYPASS] Solver returned failure: ${errMsg}`);
        lastSolveFailTime = Date.now();
        throw new Error(errMsg);
      }
    } catch (error) {
      console.error(`[CF BYPASS] Failed: ${error.message}`);
      lastSolveFailTime = Date.now();
      throw error;
    } finally {
      isSolvingCF = false;
      solvePromise = null;
    }
  })();

  return solvePromise;
}

/**
 * Run the Python cf_solver.py script and parse JSON output
 */
function runPythonSolver(url) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(__dirname, "cf_solver.py");
    const timeout = CF_SOLVE_TIMEOUT_MS + 30000; // Extra buffer for browser startup

    console.log(`[CF BYPASS] Executing: python3 ${scriptPath} ${url}`);

    const child = execFile(
      "python3",
      [scriptPath, url],
      {
        timeout,
        maxBuffer: 5 * 1024 * 1024,
        env: { ...process.env, PYTHONUNBUFFERED: "1" },
      },
      (error, stdout, stderr) => {
        if (stderr) {
          // botasaurus-driver prints progress info to stderr
          console.log(`[CF BYPASS] Python output: ${stderr.substring(0, 500)}`);
        }

        if (error) {
          console.error(`[CF BYPASS] Python process error: ${error.message}`);
          return reject(new Error(`Python solver failed: ${error.message}`));
        }

        try {
          // Find the JSON line in stdout (last non-empty line)
          const lines = stdout.trim().split("\n");
          const jsonLine = lines[lines.length - 1];
          const result = JSON.parse(jsonLine);
          resolve(result);
        } catch (parseErr) {
          console.error(`[CF BYPASS] Failed to parse output: ${stdout.substring(0, 200)}`);
          reject(new Error(`Failed to parse solver output: ${parseErr.message}`));
        }
      }
    );
  });
}

/**
 * Get valid Cloudflare cookies, solving if needed
 */
async function getCFCookies() {
  const now = Date.now();

  // If cookies are still fresh, return them
  if (cfCookies && now - cfCookieTimestamp < CF_COOKIE_REFRESH_MS) {
    return { cookies: cfCookies, userAgent: cfUserAgent };
  }

  // Need to solve/refresh
  return solveCloudflareCookies();
}

// ============================================================
// URL NORMALIZATION
// ============================================================
app.use((req, res, next) => {
  const path = req.path;
  if (path !== "/" && path.endsWith("/")) {
    const query = req.originalUrl.includes("?")
      ? req.originalUrl.substring(req.originalUrl.indexOf("?"))
      : "";
    return res.redirect(301, path.slice(0, -1) + query);
  }
  if (path !== path.toLowerCase()) {
    const query = req.originalUrl.includes("?")
      ? req.originalUrl.substring(req.originalUrl.indexOf("?"))
      : "";
    return res.redirect(301, path.toLowerCase() + query);
  }
  next();
});

// ============================================================
// CUSTOM ROBOTS.TXT
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

    // Get Cloudflare bypass cookies
    let cfData;
    try {
      cfData = await getCFCookies();
    } catch (e) {
      console.error("[PROXY] Failed to get CF cookies, trying without:", e.message);
      cfData = { cookies: "", userAgent: "" };
    }

    // Build headers with CF bypass cookies
    const proxyHeaders = {
      Host: TARGET_HOSTNAME,
      "User-Agent":
        cfData.userAgent ||
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

    // Add CF cookies if available
    if (cfData.cookies) {
      proxyHeaders["Cookie"] = cfData.cookies;
    }

    // Fetch from target
    const response = await axios({
      method: req.method,
      url: targetUrl.toString(),
      headers: proxyHeaders,
      data: req.method !== "GET" ? req.body : undefined,
      responseType: "arraybuffer",
      maxRedirects: 5,
      validateStatus: () => true,
      timeout: 15000,
      decompress: true,
    });

    const contentType = response.headers["content-type"] || "";
    const statusCode = response.status;

    // If 403 — Cloudflare blocking, force ONE re-solve and retry
    if (statusCode === 403) {
      // Check cooldown to prevent infinite loop
      if (lastSolveFailTime && Date.now() - lastSolveFailTime < CF_SOLVE_COOLDOWN_MS) {
        console.log("[PROXY] 403 received but in cooldown, returning error");
        return res.status(503).send(
          "<h1>Service Temporarily Unavailable</h1><p>Cloudflare bypass is refreshing. Please try again in 1 minute.</p>"
        );
      }

      console.log("[PROXY] Got 403, forcing Cloudflare cookie refresh (single attempt)...");
      cfCookieTimestamp = 0;

      try {
        const freshCF = await solveCloudflareCookies();

        if (!freshCF.cookies) {
          return res.status(503).send(
            "<h1>Service Temporarily Unavailable</h1><p>Cloudflare bypass failed. Please try again later.</p>"
          );
        }

        proxyHeaders["Cookie"] = freshCF.cookies;
        proxyHeaders["User-Agent"] = freshCF.userAgent;

        const retryResponse = await axios({
          method: req.method,
          url: targetUrl.toString(),
          headers: proxyHeaders,
          data: req.method !== "GET" ? req.body : undefined,
          responseType: "arraybuffer",
          maxRedirects: 5,
          validateStatus: () => true,
          timeout: 15000,
          decompress: true,
        });

        const retryContentType = retryResponse.headers["content-type"] || "";
        const retryStatusCode = retryResponse.status;

        if (retryStatusCode === 403) {
          lastSolveFailTime = Date.now();
          return res.status(503).send(
            "<h1>Service Temporarily Unavailable</h1><p>Cloudflare protection could not be bypassed. Retrying in 1 minute.</p>"
          );
        }

        return processResponse(
          retryResponse, retryContentType, retryStatusCode,
          req, res, mirrorDomain, mirrorOrigin, targetUrl
        );
      } catch (retryErr) {
        console.error("[PROXY] Retry after CF solve failed:", retryErr.message);
        lastSolveFailTime = Date.now();
        return res.status(503).send(
          "<h1>Service Temporarily Unavailable</h1><p>Cloudflare bypass failed. Please try again later.</p>"
        );
      }
    }

    return processResponse(
      response, contentType, statusCode,
      req, res, mirrorDomain, mirrorOrigin, targetUrl
    );
  } catch (error) {
    console.error(`[PROXY ERROR] ${error.message}`);
    res.status(502).send(`Error fetching the website: ${error.message}`);
  }
});

// ============================================================
// PROCESS RESPONSE — handle content types
// ============================================================
function processResponse(
  response, contentType, statusCode,
  req, res, mirrorDomain, mirrorOrigin, targetUrl
) {
  // HTML
  if (contentType.includes("text/html")) {
    let html = response.data.toString("utf-8");
    html = rewriteAllUrls(html, TARGET_HOSTNAME, mirrorDomain, mirrorOrigin);
    html = fixSeoWithDom(html, mirrorDomain, mirrorOrigin, req.originalUrl);
    html = removeAds(html);

    if (req.method === "GET" && statusCode === 200) {
      setCache(getCacheKey(targetUrl.toString()), html, contentType, statusCode);
    }

    res.status(statusCode);
    res.set("Content-Type", contentType);
    res.set("X-Cache", "MISS");
    setCorsAndSeoHeaders(res, mirrorDomain);
    return res.send(html);
  }

  // CSS
  if (contentType.includes("text/css")) {
    let css = response.data.toString("utf-8");
    css = css.replace(new RegExp(escapeRegex(TARGET_HOSTNAME), "g"), mirrorDomain);
    res.status(statusCode);
    res.set("Content-Type", contentType);
    setCorsAndSeoHeaders(res, mirrorDomain);
    return res.send(css);
  }

  // XML / SITEMAP / RSS
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

  // JSON
  if (contentType.includes("application/json")) {
    let json = response.data.toString("utf-8");
    json = json.replace(
      new RegExp(`https?://${escapeRegex(TARGET_HOSTNAME)}`, "g"), mirrorOrigin
    );
    json = json.replace(new RegExp(escapeRegex(TARGET_HOSTNAME), "g"), mirrorDomain);
    res.status(statusCode);
    res.set("Content-Type", contentType);
    setCorsAndSeoHeaders(res, mirrorDomain);
    return res.send(json);
  }

  // JAVASCRIPT
  if (
    contentType.includes("application/javascript") ||
    contentType.includes("text/javascript")
  ) {
    let js = response.data.toString("utf-8");
    js = js.replace(
      new RegExp(`https?://${escapeRegex(TARGET_HOSTNAME)}`, "g"), mirrorOrigin
    );
    js = js.replace(new RegExp(escapeRegex(TARGET_HOSTNAME), "g"), mirrorDomain);
    res.status(statusCode);
    res.set("Content-Type", contentType);
    setCorsAndSeoHeaders(res, mirrorDomain);
    return res.send(js);
  }

  // BINARY / OTHER — Pass through
  res.status(statusCode);
  res.set("Content-Type", contentType);
  setCorsAndSeoHeaders(res, mirrorDomain);

  const passHeaders = ["cache-control", "etag", "last-modified", "content-disposition"];
  passHeaders.forEach((h) => {
    if (response.headers[h]) res.set(h, response.headers[h]);
  });

  return res.send(response.data);
}

// ============================================================
// HELPER: Comprehensive URL rewriting in HTML
// ============================================================
function rewriteAllUrls(html, targetHost, mirrorDomain, mirrorOrigin) {
  const escaped = escapeRegex(targetHost);

  html = html.replace(new RegExp(`https?://${escaped}`, "g"), mirrorOrigin);
  html = html.replace(new RegExp(`//${escaped}`, "g"), `//${mirrorDomain}`);

  html = html.replace(
    /(href|src|action|data-src|data-lazy-src|data-srcset|srcset)="\/(?!\/)/g,
    `$1="${mirrorOrigin}/`
  );
  html = html.replace(
    /(href|src|action|data-src|data-lazy-src|data-srcset|srcset)='\/(?!\/)/g,
    `$1='${mirrorOrigin}/`
  );

  html = html.replace(
    new RegExp(`url\\((['"]?)https?://${escaped}`, "g"),
    `url($1${mirrorOrigin}`
  );

  html = html.replace(new RegExp(`${escaped}`, "g"), mirrorDomain);

  return html;
}

// ============================================================
// HELPER: DOM-level SEO fixing
// ============================================================
function fixSeoWithDom(html, mirrorDomain, mirrorOrigin, requestPath) {
  const currentUrl = `${mirrorOrigin}${requestPath}`.replace(/\/$/, "");

  html = html.replace(/<link[^>]*rel=["']canonical["'][^>]*\/?>/gi, "");
  html = html.replace(/<meta[^>]*property=["']og:url["'][^>]*\/?>/gi, "");
  html = html.replace(/<link[^>]*rel=["']alternate["'][^>]*\/?>/gi, "");

  const seoBlock = `
    <!-- Mirror SEO Tags - Auto Generated -->
    <link rel="canonical" href="${currentUrl}" />
    <meta property="og:url" content="${currentUrl}" />
    <meta property="og:site_name" content="${mirrorDomain}" />
    <meta name="robots" content="index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1" />
    <link rel="alternate" hreflang="id" href="${currentUrl}" />
    <link rel="alternate" hreflang="x-default" href="${currentUrl}" />
  `;

  html = html.replace(/<head([^>]*)>/i, `<head$1>${seoBlock}`);

  html = html.replace(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    (match, jsonContent) => {
      try {
        let data = JSON.parse(jsonContent);
        data = rewriteJsonLd(data, TARGET_HOSTNAME, mirrorDomain, mirrorOrigin);
        return `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
      } catch (e) {
        let fixed = jsonContent.replace(
          new RegExp(escapeRegex(TARGET_HOSTNAME), "g"), mirrorDomain
        );
        return `<script type="application/ld+json">${fixed}</script>`;
      }
    }
  );

  html = html.replace(
    new RegExp(`(<meta[^>]*content=["'])https?://${escapeRegex(TARGET_HOSTNAME)}`, "gi"),
    `$1${mirrorOrigin}`
  );

  let titleCount = 0;
  html = html.replace(/<title[^>]*>[\s\S]*?<\/title>/gi, (match) => {
    titleCount++;
    return titleCount === 1 ? match : "";
  });

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
    return obj.map((item) => rewriteJsonLd(item, targetHost, mirrorDomain, mirrorOrigin));
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
// START SERVER — Pre-solve Cloudflare on startup
// ============================================================
// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, async () => {
  console.log(`🚀 Mirror proxy running on port ${PORT}`);
  console.log(`📡 Target: ${TARGET_ORIGIN}`);
  console.log(`💡 Mirror domain: ${MANUAL_MIRROR_DOMAIN || "(auto-detect from request)"}`);
  console.log(`🔐 Using botasaurus-driver (Python) for Cloudflare bypass`);

  // Pre-solve Cloudflare cookies on startup
  try {
    console.log("[STARTUP] Pre-solving Cloudflare cookies via botasaurus-driver...");
    await solveCloudflareCookies();
    console.log("[STARTUP] Cloudflare cookies obtained successfully!");
  } catch (e) {
    console.error("[STARTUP] Failed to pre-solve Cloudflare:", e.message);
    console.log("[STARTUP] Will retry on first request...");
  }

  // Schedule periodic cookie refresh
  setInterval(async () => {
    try {
      console.log("[REFRESH] Refreshing Cloudflare cookies...");
      await solveCloudflareCookies();
      console.log("[REFRESH] Cloudflare cookies refreshed!");
    } catch (e) {
      console.error("[REFRESH] Failed to refresh CF cookies:", e.message);
    }
  }, CF_COOKIE_REFRESH_MS);
});

// ============================================================
// GRACEFUL SHUTDOWN
// ============================================================
process.on("SIGTERM", () => {
  console.log("[SHUTDOWN] Received SIGTERM");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("[SHUTDOWN] Received SIGINT");
  process.exit(0);
});
