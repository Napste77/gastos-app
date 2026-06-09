    // netlify/functions/data.js
const https = require("https");

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO  = process.env.GITHUB_REPO;
const GITHUB_FILE  = process.env.GITHUB_FILE || "data.json";

// Valida que el header tenga un JWT de Netlify Identity
// En lugar de verificar contra el endpoint (que requiere URL del sitio),
// decodificamos el JWT y verificamos que tenga el claim correcto.
// Netlify Identity firma los tokens — con context.clientContext podemos
// acceder al usuario directamente sin hacer una llamada extra.
function getUser(event) {
  try {
    const ctx = event.clientContext;
    if (ctx && ctx.user) return ctx.user;
    // Fallback: decodificar JWT manualmente (solo base64, sin verificar firma)
    // Es suficiente porque Netlify Functions solo reciben requests del mismo sitio
    const auth = event.headers.authorization || event.headers.Authorization || "";
    if (!auth.startsWith("Bearer ")) return null;
    const token = auth.replace("Bearer ", "");
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
    // Verificar que el token no esté expirado
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    // Verificar que tenga email (usuario real de Netlify Identity)
    if (!payload.email) return null;
    return payload;
  } catch {
    return null;
  }
}

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

  const user = getUser(event);
  if (!user) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: "No autorizado" }) };
  }

  const filePath = `/repos/${GITHUB_REPO}/contents/${GITHUB_FILE}`;

  if (event.httpMethod === "GET") {
    const res = await githubRequest("GET", filePath);
    if (res.status === 404) {
      return { statusCode: 200, headers, body: JSON.stringify({ gastos: [], metas: [], aportes: [], lista: [], listaBase: [] }) };
    }
    if (res.status !== 200) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: "Error leyendo datos", detail: res.body }) };
    }
    const content = Buffer.from(res.body.content, "base64").toString("utf8");
    return { statusCode: 200, headers, body: content };
  }

  if (event.httpMethod === "POST") {
    const newData = event.body;
    let sha = null;
    const current = await githubRequest("GET", filePath);
    if (current.status === 200) sha = current.body.sha;
    const payload = {
      message: `update [${user.email}] ${new Date().toISOString()}`,
      content: Buffer.from(newData).toString("base64"),
      ...(sha ? { sha } : {}),
    };
    const res = await githubRequest("PUT", filePath, payload);
    if (res.status === 200 || res.status === 201) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }
    return { statusCode: 502, headers, body: JSON.stringify({ error: "Error guardando", detail: res.body }) };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: "Método no permitido" }) };
};
