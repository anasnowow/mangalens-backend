const http = require("http");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 10000);

const MAX_HTML = 5 * 1024 * 1024;
const MAX_PAGES = 300;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

function send(res, status, data, contentType = "application/json; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store"
  });

  res.end(
    typeof data === "string"
      ? data
      : JSON.stringify(data)
  );
}

function cleanText(text) {
  return String(text || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
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

  if (
    !["http:", "https:"].includes(u.protocol)
  ) {
    throw new Error(
      "Solo se admiten URLs http/https."
    );
  }

  if (isBlockedHost(u.hostname)) {
    throw new Error(
      "Ese destino no está permitido."
    );
  }

  return u;
}

async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = 25000
) {
  const controller =
    new AbortController();

  const timer = setTimeout(
    () => controller.abort(),
    timeoutMs
  );

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      redirect: "follow"
    });
  } finally {
    clearTimeout(timer);
  }
}

function browserHeaders(url) {
  const u = new URL(url);

  return {
    "User-Agent":
      "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36",

    "Accept":
      "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",

    "Accept-Language":
      "es-ES,es;q=0.9,en-US;q=0.8,en;q=0.7",

    "Cache-Control":
      "no-cache",

    "Pragma":
      "no-cache",

    "Upgrade-Insecure-Requests":
      "1",

    "Sec-Fetch-Dest":
      "document",

    "Sec-Fetch-Mode":
      "navigate",

    "Sec-Fetch-Site":
      "none",

    "Sec-Fetch-User":
      "?1",

    "Referer":
      `${u.protocol}//${u.host}/`
  };
}

async function fetchText(url) {

  const first =
    await fetchWithTimeout(
      url,
      {
        headers:
          browserHeaders(url)
      }
    );

  if (first.ok) {

    const text =
      await first.text();

    if (
      text.length >
      MAX_HTML
    ) {
      throw new Error(
        "La página es demasiado grande."
      );
    }

    return {
      response: first,
      text
    };
  }

  /*
   * Segundo intento para respuestas
   * 403 o 429.
   *
   * No intenta resolver CAPTCHA,
   * login, paywall ni otras
   * protecciones.
   */

  if (
    first.status === 403 ||
    first.status === 429
  ) {

    const u =
      new URL(url);

    const retryHeaders =
      browserHeaders(url);

    retryHeaders["User-Agent"] =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

    retryHeaders["Sec-Fetch-Site"] =
      "same-origin";

    retryHeaders["Referer"] =
      `${u.protocol}//${u.host}/`;

    const second =
      await fetchWithTimeout(
        url,
        {
          headers:
            retryHeaders
        },
        30000
      );

    if (second.ok) {

      const text =
        await second.text();

      if (
        text.length >
        MAX_HTML
      ) {
        throw new Error(
          "La página es demasiado grande."
        );
      }

      return {
        response: second,
        text
      };
    }

    throw new Error(
      `El sitio bloqueó la importación (HTTP ${second.status}).`
    );
  }

  throw new Error(
    `El sitio respondió HTTP ${first.status}.`
  );
}

function unique(items) {
  return [
    ...new Set(
      items.filter(Boolean)
    )
  ];
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#47;/gi, "/");
}

function looksLikeImageUrl(url) {

  const value =
    url.toLowerCase();

  if (
    value.startsWith("data:") ||
    value.startsWith("blob:") ||
    value.startsWith("javascript:")
  ) {
    return false;
  }

  return (
    /\.(jpg|jpeg|png|webp|gif|avif)(?:[?#]|$)/i.test(
      value
    ) ||
    /\/(?:image|images|img|uploads|chapter|chapters|pages|manga|comic|comics)\//i.test(
      value
    ) ||
    /(?:image|img|page|chapter|manga|comic)[-_]/i.test(
      value
    )
  );
}

function addCandidate(
  list,
  raw,
  baseUrl
) {

  if (!raw) return;

  const decoded =
    decodeHtmlEntities(
      String(raw).trim()
    );

  const candidates =
    decoded
      .split(",")
      .map(x => x.trim())
      .map(x => x.split(/\s+/)[0]);

  for (
    const candidate of candidates
  ) {

    if (!candidate) continue;

    try {

      const imageUrl =
        new URL(
          candidate,
          baseUrl
        );

      if (
        (
          imageUrl.protocol === "http:" ||
          imageUrl.protocol === "https:"
        ) &&
        !isBlockedHost(
          imageUrl.hostname
        ) &&
        looksLikeImageUrl(
          imageUrl.href
        )
      ) {

        list.push(
          imageUrl.href
        );
      }

    } catch {}
  }
}

function extractImages(
  html,
  baseUrl
) {

  const images = [];

  const tagRegex =
    /<(?:img|source)[^>]*>/gi;

  let tagMatch;

  while (
    (tagMatch =
      tagRegex.exec(html)) &&
    images.length <
      MAX_PAGES * 3
  ) {

    const tag =
      tagMatch[0];

    const attrRegex =
      /\b(?:src|data-src|data-original|data-lazy-src|data-url|data-image|data-original-src|srcset|data-srcset)\s*=\s*["']([^"']+)["']/gi;

    let attrMatch;

    while (
      (attrMatch =
        attrRegex.exec(tag)) &&
      images.length <
        MAX_PAGES * 3
    ) {

      addCandidate(
        images,
        attrMatch[1],
        baseUrl
      );
    }
  }

  let match;

  const absoluteUrlRegex =
    /https?:\/\/[^"'\\\s<>]+/gi;

  while (
    (match =
      absoluteUrlRegex.exec(html)) &&
    images.length <
      MAX_PAGES * 4
  ) {

    const raw =
      match[0]
        .replace(
          /\\u002F/gi,
          "/"
        )
        .replace(
          /\\\//g,
          "/"
        );

    if (
      looksLikeImageUrl(raw)
    ) {
      addCandidate(
        images,
        raw,
        baseUrl
      );
    }
  }

  const relativeRegex =
    /["']([^"']{1,600}(?:\.(?:jpg|jpeg|png|webp|gif|avif))(?:\?[^"']*)?)["']/gi;

  while (
    (match =
      relativeRegex.exec(html)) &&
    images.length <
      MAX_PAGES * 4
  ) {

    addCandidate(
      images,
      match[1],
      baseUrl
    );
  }

  return unique(
    images
  ).slice(
    0,
    MAX_PAGES
  );
}

function findMangaDexChapterId(
  url
) {

  const match =
    url.pathname.match(
      /\/chapter\/([0-9a-f-]{20,})/i
    );

  return match
    ? match[1]
    : null;
}

async function importMangaDex(
  chapterId
) {

  const api =
    `https://api.mangadex.org/at-home/server/${encodeURIComponent(chapterId)}`;

  const response =
    await fetchWithTimeout(
      api,
      {
        headers: {
          "User-Agent":
            "MangaLens/1.0",
          "Accept":
            "application/json"
        }
      }
    );

  if (!response.ok) {

    throw new Error(
      `MangaDex API respondió HTTP ${response.status}.`
    );
  }

  const data =
    await response.json();

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
    Array.isArray(
      data.chapter.dataSaver
    ) &&
    data.chapter.dataSaver.length
      ? data.chapter.dataSaver
      : data.chapter.data || [];

  const mode =
    Array.isArray(
      data.chapter.dataSaver
    ) &&
    data.chapter.dataSaver.length
      ? "data-saver"
      : "data";

  const originalPages =
    files.map(
      filename =>
        `${data.baseUrl}/${mode}/${data.chapter.hash}/${filename}`
    );

  const pages =
    originalPages.map(
      page =>
        `/api/image?url=${encodeURIComponent(page)}&ref=${encodeURIComponent("https://mangadex.org/")}`
    );

  return {
    source: "mangadex",

    chapterId,

    title:
      data.chapter.title ||
      `Capítulo ${data.chapter.chapter || ""}`.trim() ||
      "Capítulo",

    chapter:
      data.chapter.chapter || "",

    volume:
      data.chapter.volume || "",

    pages,

    pageCount:
      pages.length,

    mode
  };
}

async function importGeneric(
  rawUrl
) {

  const url =
    validPublicUrl(
      rawUrl
    );

  const result =
    await fetchText(
      url.href
    );

  const finalUrl =
    result.response.url ||
    url.href;

  const images =
    extractImages(
      result.text,
      finalUrl
    );

  const titleMatch =
    result.text.match(
      /<title[^>]*>([\s\S]*?)<\/title>/i
    );

  const title =
    cleanText(
      titleMatch
        ? titleMatch[1]
        : "Capítulo"
    ) || "Capítulo";

  const pages =
    images.map(
      imageUrl =>
        `/api/image?url=${encodeURIComponent(imageUrl)}&ref=${encodeURIComponent(finalUrl)}`
    );

  return {
    source: "generic",

    title,

    url:
      finalUrl,

    pages,

    pageCount:
      pages.length,

    warning:
      images.length
        ? "Páginas detectadas y servidas mediante MangaLens."
        : "No se detectaron imágenes públicas. La web puede requerir JavaScript o impedir el acceso automático."
  };
}

async function handleImport(
  body
) {

  if (
    !body ||
    !body.url
  ) {
    throw new Error(
      "Falta la URL del capítulo."
    );
  }

  const url =
    validPublicUrl(
      body.url
    );

  const mangaDexId =
    findMangaDexChapterId(
      url
    );

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

async function proxyImage(
  req,
  res,
  requestUrl
) {

  const rawImageUrl =
    requestUrl.searchParams.get(
      "url"
    );

  const rawRef =
    requestUrl.searchParams.get(
      "ref"
    ) || "";

  if (!rawImageUrl) {

    return send(
      res,
      400,
      {
        ok: false,
        error:
          "Falta la URL de la imagen."
      }
    );
  }

  let imageUrl;
  let refUrl = null;

  try {

    imageUrl =
      validPublicUrl(
        rawImageUrl
      );

    if (rawRef) {

      try {

        refUrl =
          validPublicUrl(
            rawRef
          );

      } catch {}
    }

  } catch (error) {

    return send(
      res,
      400,
      {
        ok: false,
        error:
          error.message
      }
    );
  }

  try {

    const headers = {

      "User-Agent":
        "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36 MangaLens/1.0",

      "Accept":
        "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"
    };

    if (refUrl) {

      headers.Referer =
        refUrl.href;

      headers.Origin =
        `${refUrl.protocol}//${refUrl.host}`;
    }

    const response =
      await fetchWithTimeout(
        imageUrl.href,
        {
          headers
        },
        30000
      );

    if (!response.ok) {

      return send(
        res,
        response.status,
        {
          ok: false,
          error:
            `La imagen respondió HTTP ${response.status}.`
        }
      );
    }

    const contentType =
      response.headers.get(
        "content-type"
      ) ||
      "application/octet-stream";

    if (
      !contentType.startsWith(
        "image/"
      ) &&
      !contentType.includes(
        "octet-stream"
      )
    ) {

      return send(
        res,
        415,
        {
          ok: false,
          error:
            "La fuente no devolvió una imagen."
        }
      );
    }

    const contentLength =
      Number(
        response.headers.get(
          "content-length"
        ) || 0
      );

    if (
      contentLength >
      MAX_IMAGE_BYTES
    ) {

      return send(
        res,
        413,
        {
          ok: false,
          error:
            "La imagen es demasiado grande."
        }
      );
    }

    const buffer =
      Buffer.from(
        await response.arrayBuffer()
      );

    if (
      buffer.length >
      MAX_IMAGE_BYTES
    ) {

      return send(
        res,
        413,
        {
          ok: false,
          error:
            "La imagen es demasiado grande."
        }
      );
    }

    res.writeHead(
      200,
      {
        "Content-Type":
          contentType,

        "Content-Length":
          buffer.length,

        "Access-Control-Allow-Origin":
          "*",

        "Cache-Control":
          "public, max-age=3600"
      }
    );

    res.end(
      buffer
    );

  } catch (error) {

    console.error(
      "IMAGE_PROXY_ERROR",
      error
    );

    send(
      res,
      502,
      {
        ok: false,
        error:
          "No se pudo obtener la imagen desde la fuente."
      }
    );
  }
}

const server =
  http.createServer(
    async (req, res) => {

      if (
        req.method ===
        "OPTIONS"
      ) {

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
        requestUrl.pathname ===
        "/health"
      ) {

        return send(
          res,
          200,
          {
            ok: true,
            service:
              "MangaLens Backend",
            version:
              "0.3",
            imageProxy:
              true
          }
        );
      }

      if (
        requestUrl.pathname ===
        "/"
      ) {

        return send(
          res,
          200,
          {
            ok: true,
            service:
              "MangaLens Backend",
            version:
              "0.3",
            endpoints: [
              "/health",
              "/api/import",
              "/api/image"
            ]
          }
        );
      }

      if (
        requestUrl.pathname ===
        "/api/image" &&
        req.method ===
        "GET"
      ) {

        return proxyImage(
          req,
          res,
          requestUrl
        );
      }

      if (
        requestUrl.pathname ===
        "/api/import" &&
        req.method ===
        "POST"
      ) {

        let raw = "";
        let tooLarge = false;

        req.on(
          "data",
          chunk => {

            raw += chunk;

            if (
              raw.length >
              30000
            ) {

              tooLarge = true;

              req.destroy();
            }
          }
        );

        req.on(
          "end",
          async () => {

            if (tooLarge)
              return;

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
                "IMPORT_ERROR",
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
      `MangaLens Backend 0.3 escuchando en 0.0.0.0:${PORT}`
    );
  }
);
