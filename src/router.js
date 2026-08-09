// ============================================================
// Minimal HTTP router — no Express, just node:http. Supports
// path params (:id), JSON body parsing, and a static file
// fallback for the frontend.
// ============================================================
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

class Router {
  constructor() {
    this.routes = []; // {method, pattern, keys, handler}
  }

  _add(method, routePath, handler) {
    const keys = [];
    const pattern = new RegExp(
      "^" +
        routePath
          .split("/")
          .map((seg) => {
            if (seg.startsWith(":")) {
              keys.push(seg.slice(1));
              return "([^/]+)";
            }
            return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          })
          .join("/") +
        "/?$"
    );
    this.routes.push({ method, pattern, keys, handler });
  }

  get(p, h) { this._add("GET", p, h); }
  post(p, h) { this._add("POST", p, h); }
  patch(p, h) { this._add("PATCH", p, h); }
  delete(p, h) { this._add("DELETE", p, h); }

  async handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const pathname = decodeURIComponent(url.pathname);

    for (const route of this.routes) {
      if (route.method !== req.method) continue;
      const match = route.pattern.exec(pathname);
      if (!match) continue;
      const params = {};
      route.keys.forEach((key, i) => (params[key] = match[i + 1]));
      const query = Object.fromEntries(url.searchParams.entries());

      try {
        let body = undefined;
        if (["POST", "PATCH", "PUT"].includes(req.method)) {
          body = await readJsonBody(req);
        }
        await route.handler({ req, res, params, query, body });
      } catch (err) {
        console.error("Route error:", err);
        sendJson(res, 500, { error: err.message || "Internal server error" });
      }
      return true;
    }
    return false;
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "access-control-allow-origin": "*",
  });
  res.end(body);
}

function sendText(res, status, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(text),
    "access-control-allow-origin": "*",
  });
  res.end(text);
}

function serveStatic(rootDir) {
  return function (req, res) {
    let reqPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (reqPath === "/") reqPath = "/index.html";
    const filePath = path.join(rootDir, reqPath);
    if (!filePath.startsWith(rootDir)) {
      sendText(res, 403, "Forbidden");
      return true;
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return false;
    const ext = path.extname(filePath);
    const contentType = MIME[ext] || "application/octet-stream";
    res.writeHead(200, { "content-type": contentType });
    fs.createReadStream(filePath).pipe(res);
    return true;
  };
}

module.exports = { Router, sendJson, sendText, serveStatic };
