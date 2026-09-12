const http = require("http");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 10000);
const MAX_HTML = 3 * 1024 * 1024;
const MAX_PAGES = 200;

function send(res, status, data, contentType = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store"
  });

  res.end(typeof data === "string" ? data : JSON.stringify(data));
}

function cleanText(text) {
  return String(text || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isBlockedHost(hostname) {
  const h = hostname.toLowerCase();

  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "::1" ||
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h === "0.0.0.0" ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(h)
  );
}

function validPublicUrl(raw) {
  let u;

  try {
    u = new URL(raw);
  } catch {
    throw new Error("La URL no es válida.");
  }

  if (!["http:", "https:"].includes(u.protocol)) {
    throw new Error("Solo se admiten URLs http/https.");
  }

  if (isBlockedHost(u.hostname)) {
    throw new Error("Ese destino no está permitido.");
  }

  return u;
}

async function fetchText(url, timeoutMs = 20000) {
  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": "MangaLens/0.1",
        "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"
      }
    });

    if (!response.ok) {
      throw new Error(`El sitio respondió HTTP ${response.status}.`);
    }

    const text = await response.text();

    if (text.length > MAX_HTML) {
      throw new Error("La página es demasiado grande.");
    }

    return {
      response,
      text
    };
  } finally {
    clearTimeout(timer);
  }
}

function unique(items) {
  return [...new Set(items.filter(Boolean))];
}

function extractImages(html, baseUrl) {
  const images = [];

  const attributeRegex =
    /<(?:img|source)[^>]+(?:src|data-src|data-original|data-lazy-src|srcset)\s*=\s*["']([^"']+)["'][^>]*>/gi;

  let match;

  while (
    (match = attributeRegex.exec(html)) &&
    images.length < MAX_PAGES * 2
  ) {
    const raw = match[1].trim();

    const candidates = raw
      .split(",")
      .map(item => item.trim().split(/\s+/)[0]);

    for (const candidate of candidates) {
      if (!candidate) continue;

      try {
        const imageUrl = new URL(candidate, baseUrl);

        if (
          imageUrl.protocol === "http:" ||
          imageUrl.protocol === "https:"
        ) {
          images.push(imageUrl.href);
        }
      } catch {}
    }
  }

  const jsonRegex =
    /["'](https?:\/\/[^"'\\\s]+?\.(?:jpg|jpeg|png|webp|gif)(?:\?[^"'\\\s]*)?)["']/gi;

  while (
    (match = jsonRegex.exec(html)) &&
    images.length < MAX_PAGES * 2
  ) {
    images.push(match[1]);
  }

  return unique(images).slice(0, MAX_PAGES);
}

async function importMangaDex(chapterId) {
  const api =
    `https://api.mangadex.org/at-home/server/${encodeURIComponent(chapterId)}`;

  const response = await fetch(api, {
    headers: {
      "User-Agent": "MangaLens/0.1",
      "Accept": "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(
      `MangaDex API respondió HTTP ${response.status}.`
    );
  }

  const data = await response.json();

  if (
    !data.baseUrl ||
    !data.chapter ||
    !data.chapter.hash
  ) {
    throw new Error(
      "MangaDex no devolvió los datos del capítulo."
    );
  }

  const files =
    Array.isArray(data.chapter.data) &&
    data.chapter.data.length
      ? data.chapter.data
      : data.chapter.dataSaver || [];

  const mode =
    data.chapter.data &&
    data.chapter.data.length
      ? "data"
      : "data-saver";

  const pages = files.map(filename =>
    `${data.baseUrl}/${mode}/${data.chapter.hash}/${filename}`
  );

  return {
    source: "mangadex",
    chapterId,
    title:
      data.chapter.title ||
      `Capítulo ${data.chapter.chapter || ""}`.trim(),
    chapter: data.chapter.chapter || "",
    volume: data.chapter.volume || "",
    pages,
    pageCount: pages.length
  };
}

function findMangaDexChapterId(url) {
  const match =
    url.pathname.match(
      /\/chapter\/([0-9a-f-]{20,})/i
    );

  return match ? match[1] : null;
}

async function importGeneric(rawUrl) {
  const url = validPublicUrl(rawUrl);

  const result = await fetchText(url.href);

  const finalUrl =
    result.response.url || url.href;

  const images =
    extractImages(result.text, finalUrl);

  const titleMatch =
    result.text.match(
      /<title[^>]*>([\s\S]*?)<\/title>/i
    );

  const title =
    cleanText(
      titleMatch ? titleMatch[1] : "Capítulo"
    ) || "Capítulo";

  return {
    source: "generic",
    title,
    url: finalUrl,
    pages: images,
    pageCount: images.length,
    warning: images.length
      ? "Se han detectado imágenes públicas en la página."
      : "No se detectaron imágenes. La web puede cargar el capítulo mediante JavaScript o impedir el acceso automático."
  };
}

async function handleImport(body) {
  const rawUrl = body && body.url;

  if (!rawUrl) {
    throw new Error(
      "Falta la URL del capítulo."
    );
  }

  const url =
    validPublicUrl(rawUrl);

  const mangaDexId =
    findMangaDexChapterId(url);

  if (
    url.hostname
      .toLowerCase()
      .endsWith("mangadex.org") &&
    mangaDexId
  ) {
    return await importMangaDex(
      mangaDexId
    );
  }

  return await importGeneric(
    url.href
  );
}

const server =
  http.createServer(
    async (req, res) => {

      if (req.method === "OPTIONS") {
        return send(
          res,
          204,
          ""
        );
      }

      const requestUrl =
        new URL(
          req.url,
          `http://${req.headers.host || "localhost"}`
        );

      if (
        requestUrl.pathname === "/health"
      ) {
        return send(
          res,
          200,
          {
            ok: true,
            service: "MangaLens Backend",
            version: "0.1"
          }
        );
      }

      if (
        requestUrl.pathname === "/"
      ) {
        return send(
          res,
          200,
          {
            ok: true,
            service: "MangaLens Backend",
            endpoints: [
              "/health",
              "/api/import"
            ]
          }
        );
      }

      if (
        requestUrl.pathname === "/api/import" &&
        req.method === "POST"
      ) {

        let raw = "";

        req.on(
          "data",
          chunk => {
            raw += chunk;

            if (raw.length > 20000) {
              req.destroy();
            }
          }
        );

        req.on(
          "end",
          async () => {
            try {

              const body =
                JSON.parse(
                  raw || "{}"
                );

              const result =
                await handleImport(
                  body
                );

              send(
                res,
                200,
                {
                  ok: true,
                  ...result
                }
              );

            } catch (error) {

              console.error(
                error
              );

              send(
                res,
                400,
                {
                  ok: false,
                  error:
                    error &&
                    error.message
                      ? error.message
                      : "No se pudo importar el capítulo."
                }
              );
            }
          }
        );

        return;
      }

      send(
        res,
        404,
        {
          ok: false,
          error:
            "Ruta no encontrada."
        }
      );
    }
  );

server.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `MangaLens Backend escuchando en 0.0.0.0:${PORT}`
    );
  }
);
