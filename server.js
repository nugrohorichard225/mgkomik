const express = require("express");
const axios = require("axios");
const { JSDOM } = require("jsdom");
const { URL } = require("url");

// Botasaurus approach: rebrowser-playwright-core + chrome-launcher
// These are ESM modules, loaded via dynamic import() in init()
let chromium;
let ChromeLauncher;

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
// CLOUDFLARE BYPASS — Botasaurus approach
// rebrowser-playwright-core + chrome-launcher
// ============================================================
const { execSync } = require("child_process");

let cfCookies = "";
let cfUserAgent = "";
let cfCookieTimestamp = 0;
let isSolvingCF = false;
let solvePromise = null;
let xvfbStarted = false;

/**
 * Start Xvfb virtual display so Chrome runs in headed mode
 * Headed mode is REQUIRED — headless is detected by Cloudflare
 */
function ensureXvfb() {
  if (xvfbStarted) return;
  try {
    // Kill any existing Xvfb
    try { execSync("pkill -f Xvfb", { stdio: "ignore" }); } catch (e) {}
    // Start Xvfb on display :99
    execSync("Xvfb :99 -screen 0 1920x1080x24 -ac -nolisten tcp &", {
      stdio: "ignore",
      shell: true,
    });
    process.env.DISPLAY = ":99";
    xvfbStarted = true;
    console.log("[XVFB] Virtual display started on :99");
  } catch (e) {
    console.error("[XVFB] Failed to start:", e.message);
  }
}

/**
 * Launch Chrome using botasaurus anti-detect flags
 * dan connect via CDP dengan rebrowser-playwright-core
 */
async function launchAntiDetectChrome() {
  // Ensure virtual display is running (headed mode required for CF bypass)
  ensureXvfb();

  const flags = [
    "--start-maximized",
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-service-autorun",
    "--homepage=about:blank",
    "--no-pings",
    "--password-store=basic",
    "--disable-infobars",
    "--disable-breakpad",
    "--disable-dev-shm-usage",
    "--disable-session-crashed-bubble",
    "--disable-features=IsolateOrigins,site-per-process",
    "--disable-search-engine-choice-screen",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-setuid-sandbox",
    "--window-size=1920,1080",
    // Critical anti-detection flags
    "--disable-blink-features=AutomationControlled",
    "--disable-features=AutomationControlled",
    "--disable-ipc-flooding-protection",
    "--enable-features=NetworkService,NetworkServiceInProcess",
    "--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
    // NO --headless flag! Headed mode is required to bypass Cloudflare
  ];

  // Launch real Chrome via chrome-launcher (like botasaurus page.ts)
  const chrome = await ChromeLauncher.launch({
    chromeFlags: flags,
    chromePath: process.env.CHROME_PATH || undefined,
  });

  // Connect rebrowser-playwright-core via CDP (anti-detect playwright)
  const browser = await chromium.connectOverCDP(`http://localhost:${chrome.port}`);
  const context = browser.contexts()[0];

  // Inject stealth scripts BEFORE any page loads
  await context.addInitScript(() => {
    // Hide webdriver flag
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
    });
    // Remove automation-related properties
    delete navigator.__proto__.webdriver;

    // Add chrome runtime object (missing in automated browsers)
    if (!window.chrome) {
      window.chrome = {};
    }
    if (!window.chrome.runtime) {
      window.chrome.runtime = {
        onMessage: { addListener: function() {}, removeListener: function() {} },
        sendMessage: function() {},
        connect: function() { return { onMessage: { addListener: function() {} } }; },
      };
    }

    // Override plugins to look real
    Object.defineProperty(navigator, 'plugins', {
      get: () => {
        const plugins = [
          { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
          { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
          { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
        ];
        plugins.length = 3;
        return plugins;
      },
    });

    // Override languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en', 'id'],
    });

    // Override permissions
    const origQuery = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = (parameters) => {
      if (parameters.name === 'notifications') {
        return Promise.resolve({ state: 'prompt', onchange: null });
      }
      return origQuery(parameters);
    };

    // Override connection (automation often has no rtt)
    if (navigator.connection) {
      Object.defineProperty(navigator.connection, 'rtt', { get: () => 50 });
    }

    // Hide CDP artifacts
    const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
    if (descriptor) {
      Object.defineProperty(document, 'hidden', { get: () => false });
      Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
    }

    // Override toString to not leak [native code] changes
    const oldCall = Function.prototype.toString.call;
    function overrideToString(fn, str) {
      const newFn = function() { 
        if (this === fn) return str;
        return oldCall.call(this);
      };
      fn.toString = newFn;
    }
    overrideToString(navigator.permissions.query, 'function query() { [native code] }');
  });

  return {
    browser,
    context,
    kill: async () => {
      try { await context.close(); } catch (e) {}
      try { await browser.close(); } catch (e) {}
      try { await chrome.kill(); } catch (e) {}
    },
  };
}

/**
 * Solve Cloudflare challenge dan extract cookies
 * Menggunakan teknik Google Referrer seperti botasaurus google_get
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
    console.log("[CF BYPASS] Launching anti-detect Chrome (HEADED mode via Xvfb)...");
    let instance = null;

    try {
      instance = await launchAntiDetectChrome();
      const page = await instance.context.newPage();

      // Navigate directly to target with Google referrer
      // This is more reliable than navigating to Google first
      console.log(`[CF BYPASS] Navigating to ${TARGET_ORIGIN} with Google referrer...`);
      await page.goto(TARGET_ORIGIN, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
        referer: "https://www.google.com/",
      });

      // Wait for Cloudflare challenge to resolve
      console.log("[CF BYPASS] Waiting for Cloudflare challenge to resolve...");
      const passed = await waitForCloudflareToPass(page);

      // Extract cookies
      const cookies = await instance.context.cookies(TARGET_ORIGIN);
      const cfClearance = cookies.find((c) => c.name === "cf_clearance");
      const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

      // Get the actual User-Agent used by the browser
      const browserUA = await page.evaluate(() => navigator.userAgent);

      if (cfClearance) {
        console.log(`[CF BYPASS] SUCCESS! Got cf_clearance cookie`);
        console.log(`[CF BYPASS] All cookies: ${cookies.map((c) => c.name).join(", ")}`);
        cfCookies = cookieStr;
        cfUserAgent = browserUA;
        cfCookieTimestamp = Date.now();
        lastSolveFailTime = 0;
      } else {
        console.log(`[CF BYPASS] WARNING: No cf_clearance cookie obtained (got ${cookies.length} cookies: ${cookies.map((c) => c.name).join(", ")})`);
        // Still set what we got — some sites work without cf_clearance
        if (cookies.length > 0) {
          cfCookies = cookieStr;
          cfUserAgent = browserUA;
          cfCookieTimestamp = Date.now();
        } else {
          lastSolveFailTime = Date.now();
        }
      }

      await page.close();
      await instance.kill();
      instance = null;

      return { cookies: cfCookies, userAgent: cfUserAgent || browserUA };
    } catch (error) {
      console.error(`[CF BYPASS] Failed: ${error.message}`);
      lastSolveFailTime = Date.now();
      if (instance) {
        try { await instance.kill(); } catch (e) {}
      }
      throw error;
    } finally {
      isSolvingCF = false;
      solvePromise = null;
    }
  })();

  return solvePromise;
}

/**
 * Wait for Cloudflare challenge page to finish
 */
async function waitForCloudflareToPass(page) {
  const startTime = Date.now();

  // Phase 1: Wait for initial load and let CF JS challenge auto-solve (15s)
  // Many CF challenges auto-complete if the browser looks legitimate
  console.log("[CF BYPASS] Phase 1: Waiting for auto-solve (15s)...");
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: 10000 });
  } catch (e) {}

  // Wait 15 seconds for auto-solve attempt
  for (let i = 0; i < 10; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      const title = await page.title();
      const url = page.url();
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      console.log(`[CF BYPASS] [${elapsed}s] Title: ${title.substring(0, 50)} | URL: ${url.substring(0, 60)}`);

      if (!isCFChallengePage(title) && url.includes(TARGET_HOSTNAME)) {
        await new Promise((r) => setTimeout(r, 2000));
        console.log("[CF BYPASS] Challenge auto-solved!");
        return true;
      }
    } catch (e) {}
  }

  // Phase 2: Try human-like Turnstile interaction
  console.log("[CF BYPASS] Phase 2: Attempting human-like Turnstile interaction...");
  for (let attempt = 0; attempt < 3; attempt++) {
    if (Date.now() - startTime > CF_SOLVE_TIMEOUT_MS) break;

    try {
      // Find Turnstile iframe
      const frames = page.frames();
      let turnstileFrame = null;
      for (const frame of frames) {
        if (frame.url().includes("challenges.cloudflare.com")) {
          turnstileFrame = frame;
          break;
        }
      }

      if (turnstileFrame) {
        console.log(`[CF BYPASS] Attempt ${attempt + 1}: Found Turnstile iframe`);

        // Get iframe bounding box on the main page
        const iframeElement = await page.$('iframe[src*="challenges.cloudflare.com"]');
        if (iframeElement) {
          const box = await iframeElement.boundingBox();
          if (box) {
            // The checkbox is typically at ~30,30 inside the iframe
            const targetX = box.x + 30;
            const targetY = box.y + 30;

            console.log(`[CF BYPASS] Turnstile iframe at (${Math.round(box.x)}, ${Math.round(box.y)}), clicking checkbox at (${Math.round(targetX)}, ${Math.round(targetY)})`);

            // Human-like mouse movement: start from random position
            const startX = 300 + Math.random() * 400;
            const startY = 200 + Math.random() * 300;
            await page.mouse.move(startX, startY);
            await new Promise((r) => setTimeout(r, 200 + Math.random() * 300));

            // Move to target with realistic steps
            const steps = 15 + Math.floor(Math.random() * 15);
            await page.mouse.move(targetX, targetY, { steps });
            await new Promise((r) => setTimeout(r, 100 + Math.random() * 200));

            // Click with slight random offset
            await page.mouse.click(
              targetX + (Math.random() * 4 - 2),
              targetY + (Math.random() * 4 - 2),
              { delay: 50 + Math.random() * 80 }
            );
            console.log("[CF BYPASS] Clicked Turnstile with human-like movement");
          }
        }
      } else {
        console.log(`[CF BYPASS] Attempt ${attempt + 1}: No Turnstile iframe found, trying page click`);
        // Try clicking where Turnstile usually appears
        await humanMouseMove(page, 160, 290);
        await page.mouse.click(160, 290, { delay: 60 + Math.random() * 80 });
      }

      // Wait for result after clicking
      console.log("[CF BYPASS] Waiting for challenge resolution after click...");
      for (let j = 0; j < 8; j++) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const title = await page.title();
          const url = page.url();
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          console.log(`[CF BYPASS] [${elapsed}s] Title: ${title.substring(0, 50)}`);

          if (!isCFChallengePage(title) && url.includes(TARGET_HOSTNAME)) {
            await new Promise((r) => setTimeout(r, 2000));
            console.log("[CF BYPASS] Challenge passed after click!");
            return true;
          }
        } catch (e) {}
      }
    } catch (e) {
      console.log(`[CF BYPASS] Interaction error: ${e.message.substring(0, 60)}`);
    }
  }

  console.log("[CF BYPASS] Timeout waiting for Cloudflare challenge");
  return false;
}

function isCFChallengePage(title) {
  return (
    title.includes("Just a moment") ||
    title.includes("Checking your browser") ||
    title.includes("Attention Required") ||
    title.includes("Verify you are human") ||
    title.includes("Security check")
  );
}

async function humanMouseMove(page, targetX, targetY) {
  const startX = 100 + Math.random() * 600;
  const startY = 100 + Math.random() * 400;
  await page.mouse.move(startX, startY);
  await new Promise((r) => setTimeout(r, 100 + Math.random() * 200));
  const steps = 10 + Math.floor(Math.random() * 20);
  await page.mouse.move(targetX, targetY, { steps });
  await new Promise((r) => setTimeout(r, 80 + Math.random() * 150));
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
// INIT — Load ESM modules then start server
// ============================================================
async function init() {
  // Dynamic import for ESM-only packages
  const pw = await import("rebrowser-playwright-core");
  chromium = pw.chromium;
  ChromeLauncher = await import("chrome-launcher");

  app.listen(PORT, async () => {
    console.log(`🚀 Mirror proxy running on port ${PORT}`);
    console.log(`📡 Target: ${TARGET_ORIGIN}`);
    console.log(`💡 Mirror domain: ${MANUAL_MIRROR_DOMAIN || "(auto-detect from request)"}`);
    console.log(`🔐 Using Botasaurus anti-detect approach for Cloudflare bypass`);

    // Pre-solve Cloudflare cookies on startup
    try {
      console.log("[STARTUP] Pre-solving Cloudflare cookies...");
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
}

init().catch((err) => {
  console.error("[FATAL] Failed to initialize:", err);
  process.exit(1);
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
