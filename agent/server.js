/**
 * Aevum Invoice Agent — demo server.
 * Serves the static frontend and the /api/parse endpoint (natural language
 * -> structured invoice). No framework, no database. Run: node agent/server.js
 * Env: PORT (default 3000), OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL
 *      (optional — enables the LLM parsing layer; falls back to rules).
 */
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const http = require("http");
const fs = require("fs");
const path = require("path");
const { parseInvoiceRequest } = require("./parse");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC_DIR, urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: "forbidden" });
  fs.readFile(filePath, (err, data) => {
    if (err) return sendJson(res, 404, { error: "not found" });
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      service: "aevum-invoice-agent",
      llm: !!process.env.OPENAI_API_KEY,
      time: new Date().toISOString(),
    });
  }
  if (req.method === "GET" && req.url === "/api/config") {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(PUBLIC_DIR, "config.json"), "utf8"));
      return sendJson(res, 200, cfg);
    } catch {
      return sendJson(res, 200, { chainId: 44005, contractAddress: null, tusd8: "0x456569838f1d43009A91ebA4263147Afd7233483", explorer: "https://explorer-test.qday.info" });
    }
  }
  if (req.method === "POST" && req.url === "/api/parse") {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 8192) req.destroy();
    });
    req.on("end", async () => {
      try {
        const { text } = JSON.parse(body || "{}");
        const result = await parseInvoiceRequest(text || "");
        return sendJson(res, 200, result);
      } catch (e) {
        return sendJson(res, 400, { error: "invalid request", detail: String(e.message || e) });
      }
    });
    return;
  }
  if (req.method === "GET") return serveStatic(req, res);
  return sendJson(res, 405, { error: "method not allowed" });
});

server.listen(PORT, () => {
  console.log(`Aevum Invoice Agent demo running at http://localhost:${PORT}`);
  console.log(`LLM parsing: ${process.env.OPENAI_API_KEY ? "enabled" : "disabled (rule-based parser)"}`);
});
