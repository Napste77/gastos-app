// netlify/functions/data.js
// Intermediario entre el frontend y GitHub API.
// Solo responde si el usuario tiene un JWT válido de Netlify Identity.

const https = require("https");

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;       // var de entorno en Netlify
const GITHUB_REPO  = process.env.GITHUB_REPO;        // ej: "fede/gastos-data"
const GITHUB_FILE  = process.env.GITHUB_FILE || "data.json";
const NETLIFY_SITE = 'https://gastospaufede.netlify.app';                 // Netlify lo inyecta automáticamente

// ── Valida el JWT de Netlify Identity ──────────────────────────────────────
async function validateToken(authHeader) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.replace("Bearer ", "");

  // Netlify Identity expone un endpoint para verificar tokens
  const siteUrl = NETLIFY_SITE || "";
  const verifyUrl = `${siteUrl}/.netlify/identity/user`;

  return new Promise((resolve) => {
    const url = new URL(verifyUrl);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    };
    const req = https.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () => {
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(body)); }
          catch { resolve(null); }
        } else {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}

// ── Llama a la GitHub API ──────────────────────────────────────────────────
function githubRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.github.com",
      path,
      method,
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        "User-Agent": "gastos-app",
        "Content-Type": "application/json",
        Accept: "application/vnd.github.v3+json",
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ── Handler principal ──────────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  // 1. Validar identidad
  const user = await validateToken(event.headers.authorization);
  if (!user) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "No autorizado" }) };
  }

  const filePath = `/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`;

  // 2. GET → leer datos
  if (event.httpMethod === "GET") {
    const res = await githubRequest("GET", filePath);
    if (res.status === 404) {
      // Archivo no existe aún → devolvemos estructura vacía
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ gastos: [], metas: [], aportes: [] }),
      };
    }
    if (res.status !== 200) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: "Error leyendo datos" }) };
    }
    const content = Buffer.from(res.body.content, "base64").toString("utf8");
    return { statusCode: 200, headers, body: content };
  }

  // 3. POST → escribir datos
  if (event.httpMethod === "POST") {
    const newData = event.body;

    // Necesitamos el SHA actual del archivo para poder actualizarlo
    let sha = null;
    const current = await githubRequest("GET", filePath);
    if (current.status === 200) sha = current.body.sha;

    const payload = {
      message: `update data [${new Date().toISOString()}]`,
      content: Buffer.from(newData).toString("base64"),
      ...(sha ? { sha } : {}),
    };

    const res = await githubRequest("PUT", filePath, payload);
    if (res.status === 200 || res.status === 201) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }
    return { statusCode: 502, headers, body: JSON.stringify({ error: "Error guardando datos", detail: res.body }) };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: "Método no permitido" }) };
};
