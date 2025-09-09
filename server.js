const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

const cspHashes = {
    scripts: new Set(),
    styles: new Set(),
};

function calculateHash(content, algorithm = "sha256") {
    return crypto
        .createHash(algorithm)
        .update(content, "utf8")
        .digest("base64");
}

function extractInlineContent(html) {
    const scriptMatches =
        html.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi) || [];
    const styleMatches = html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || [];

    cspHashes.scripts.clear();
    cspHashes.styles.clear();

    scriptMatches.forEach((match) => {
        const content = match.replace(/<script[^>]*>|<\/script>/gi, "").trim();
        if (content) {
            const hash = calculateHash(content);
            cspHashes.scripts.add(`'sha256-${hash}'`);
            console.log(`Inline script hash: sha256-${hash}`);
        }
    });

    styleMatches.forEach((match) => {
        const content = match.replace(/<style[^>]*>|<\/style>/gi, "").trim();
        if (content) {
            const hash = calculateHash(content);
            cspHashes.styles.add(`'sha256-${hash}'`);
            console.log(`Inline style hash: sha256-${hash}`);
        }
    });
}

function generateCSP() {
    const scriptSources = Array.from(cspHashes.scripts);
    const styleSources = Array.from(cspHashes.styles);

    let scriptSrc = "'self'";
    if (scriptSources.length > 0) {
        scriptSrc += ` ${scriptSources.join(" ")}`;
    }
    if (scriptSources.length === 0) {
        scriptSrc += " 'unsafe-inline'";
    }

    let styleSrc = "'self'";
    if (styleSources.length > 0) {
        styleSrc += ` ${styleSources.join(" ")}`;
    }
    if (styleSources.length === 0) {
        styleSrc += " 'unsafe-inline'";
    }

    const csp = [
        "default-src 'self'",
        `script-src ${scriptSrc}`,
        `style-src ${styleSrc}`,
        "img-src 'self' data: https:",
        "font-src 'self'",
        "connect-src 'self'",
        "media-src 'self'",
        "object-src 'none'",
        "child-src 'none'",
        "worker-src 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
        "base-uri 'self'",
        "manifest-src 'self'",
    ].join("; ");

    const hashCount = scriptSources.length + styleSources.length;
    console.log(`Generated CSP with ${hashCount} inline content hashes:`);
    console.log(`${csp}\n`);
    return csp;
}

function minifyCSS(src) {
    let out = src
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\s+/g, " ")
        .replace(/\s*([{}:;,>+~\(\)\[\]'"*\/])\s*/g, "$1")
        .replace(/;}/g, "}")
        .replace(/\b0+(px|em|rem|vh|vw|%|s|ms)\b/g, "0")
        .replace(/\b0+\.(\d+)/g, ".$1") // 0.5 -> .5
        .replace(/#([0-9a-fA-F])\1([0-9a-fA-F])\2([0-9a-fA-F])\3\b/g, "#$1$2$3")
        .replace(
            /rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g,
            (m, r, g, b) => {
                const toHex = (n) => parseInt(n).toString(16).padStart(2, "0");
                return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
            }
        )
        .replace(/calc\(\s*([^)]+)\s*\)/g, (m, expr) => {
            return `calc(${expr.replace(/\s+/g, "")})`;
        })
        .replace(/(['"])([a-zA-Z0-9\-_]+)\1/g, (m, q, val) => {
            if (/^[a-zA-Z\-_][a-zA-Z0-9\-_]*$/.test(val)) return val;
            return m;
        })
        .replace(
            /([^{}]+)\{([^}]*)\}([^{}]+)\{([^}]*)\}/g,
            (m, sel1, rules1, sel2, rules2) => {
                if (rules1 === rules2) return `${sel1},${sel2}{${rules1}}`;
                return m;
            }
        )
        .replace(/[^{}]+\{\s*\}/g, "")
        .replace(/(margin|padding):([^;]+)/g, (m, prop, vals) => {
            const parts = vals.trim().split(/\s+/);
            if (parts.length === 4) {
                const [t, r, b, l] = parts;
                if (t === r && r === b && b === l) return `${prop}:${t}`;
                if (t === b && r === l) return `${prop}:${t} ${r}`;
            } else if (parts.length === 2) {
                const [tb, lr] = parts;
                if (tb === lr) return `${prop}:${tb}`;
            }
            return m;
        })
        .replace(/border-radius:([^;]+)/g, (m, vals) => {
            const parts = vals.trim().split(/\s+/);
            if (parts.length === 4 && parts.every((p) => p === parts[0])) {
                return `border-radius:${parts[0]}`;
            }
            return m;
        })
        .replace(
            /-webkit-(transform|transition|animation|box-shadow|border-radius):/g,
            "$1:"
        )
        .replace(
            /-moz-(transform|transition|animation|box-shadow|border-radius):/g,
            "$1:"
        )
        .replace(/-ms-(transform|transition|animation):/g, "$1:")
        .replace(
            /translate\(\s*([^,]+)\s*,\s*([^)]+)\s*\)/g,
            "translate($1,$2)"
        )
        .replace(/scale\(\s*([^,]+)\s*,\s*([^)]+)\s*\)/g, (m, x, y) => {
            return x === y ? `scale(${x})` : `scale(${x},${y})`;
        })
        .replace(/@media\s+([^{]+)\s*\{/g, "@media $1{")
        .replace(/linear-gradient\(\s*([^)]+)\s*\)/g, (m, args) => {
            return `linear-gradient(${args.replace(/\s*,\s*/g, ",")})`;
        })
        .replace(/radial-gradient\(\s*([^)]+)\s*\)/g, (m, args) => {
            return `radial-gradient(${args.replace(/\s*,\s*/g, ",")})`;
        })
        .replace(/,\s+/g, ",")
        .replace(/:\s+/g, ":")
        .replace(/;\s+/g, ";")
        .replace(/\{\s+/g, "{")
        .replace(/\s+\}/g, "}")
        .replace(/>\s+/g, ">")
        .replace(/\+\s+/g, "+")
        .replace(/~\s+/g, "~");

    return out.replace(/\r?\n/g, "").trim();
}

function minifyHTML(src) {
    let out = src
        .replace(/<!--(?!\[if)[\s\S]*?-->/g, "")
        .replace(/>\s+</g, "><")
        .replace(/>\s+([^<]+?)\s+</g, ">$1<")
        .replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (m, css) => {
            return m.replace(css, minifyCSS(css));
        })
        .replace(/\s+([\w-]+)=["']([^"'\s<>]+)["']/g, (m, attr, val) => {
            if (/^[a-zA-Z0-9._:/-]+$/.test(val)) return ` ${attr}=${val}`;
            return m;
        })
        .replace(/\s*=\s*/g, "=")
        .replace(/\s+>/g, ">")
        .replace(/\s{2,}/g, " ")
        .replace(/<([^>]+)\s+>/g, "<$1>")
        .replace(/\s+[\w-]+=["']["']/g, "")
        .replace(/\s+type=["']text\/(javascript|css)["']/g, "");

    return out.replace(/\r?\n/g, "").trim();
}

function minifyJS(src) {
    let out = "";
    let i = 0,
        n = src.length;
    let inStr = false,
        strQuote = "",
        inTemplate = false,
        escape = false;

    while (i < n) {
        const ch = src[i];
        const next = src[i + 1];

        if (inStr) {
            out += ch;
            if (!escape && ch === strQuote) {
                inStr = false;
                strQuote = "";
            }
            escape = !escape && ch === "\\";
            i++;
            continue;
        }

        if (inTemplate) {
            out += ch;
            if (!escape && ch === "`") {
                inTemplate = false;
            }
            escape = !escape && ch === "\\";
            i++;
            continue;
        }

        if (ch === '"' || ch === "'") {
            inStr = true;
            strQuote = ch;
            out += ch;
            i++;
            continue;
        }

        if (ch === "`") {
            inTemplate = true;
            out += ch;
            i++;
            continue;
        }
        if (ch === "/" && next === "*") {
            i += 2;
            while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
            i += 2;
            continue;
        }
        if (ch === "/" && next === "/") {
            i += 2;
            while (i < n && src[i] !== "\n") i++;
            continue;
        }

        out += ch;
        i++;
    }

    let finalOut = "";
    inStr = false;
    strQuote = "";
    inTemplate = false;
    escape = false;

    for (let j = 0; j < out.length; j++) {
        const ch = out[j];
        const prev = finalOut[finalOut.length - 1];

        if (inStr) {
            finalOut += ch;
            if (!escape && ch === strQuote) {
                inStr = false;
                strQuote = "";
            }
            escape = !escape && ch === "\\";
            continue;
        }

        if (inTemplate) {
            finalOut += ch;
            if (!escape && ch === "`") {
                inTemplate = false;
            }
            escape = !escape && ch === "\\";
            continue;
        }

        if (ch === '"' || ch === "'") {
            inStr = true;
            strQuote = ch;
            finalOut += ch;
            continue;
        }

        if (ch === "`") {
            inTemplate = true;
            finalOut += ch;
            continue;
        }

        if (/\s/.test(ch)) {
            let k = j + 1;
            while (k < out.length && /\s/.test(out[k])) k++;
            const nxt = out[k];

            if (
                (/[a-zA-Z0-9_$]/.test(prev) && /[a-zA-Z0-9_$]/.test(nxt)) ||
                (prev === "return" && /[a-zA-Z0-9_$"]/.test(nxt))
            ) {
                finalOut += " ";
            }
            j = k - 1;
            continue;
        }

        if (/[=;:,{}()<>+\-*\/\?|&!]/.test(ch) && finalOut.endsWith(" ")) {
            finalOut = finalOut.slice(0, -1);
        }

        finalOut += ch;
    }

    return finalOut
        .replace(/\r?\n/g, "")
        .replace(/;}/g, "}")
        .replace(/===true/g, "")
        .replace(/!==false/g, "")
        .replace(/==true/g, "")
        .replace(/!=false/g, "")
        .replace(/\["([a-zA-Z_$][a-zA-Z0-9_$]*)"\]/g, ".$1")
        .trim();
}

const files = new Map();

function contentTypeFor(fp) {
    const ext = path.extname(fp).toLowerCase();
    switch (ext) {
        case ".html":
            return "text/html; charset=utf-8";
        case ".css":
            return "text/css; charset=utf-8";
        case ".js":
            return "application/javascript; charset=utf-8";
        case ".webp":
            return "image/webp";
        case ".xml":
            return "application/xml; charset=utf-8";
        case ".txt":
            return "text/plain; charset=utf-8";
        default:
            return "application/octet-stream";
    }
}

function cacheControlFor(fp) {
    const ext = path.extname(fp).toLowerCase();
    if (ext === ".html") return "no-cache";
    if (ext === ".css" || ext === ".js")
        return "public, max-age=31536000, immutable";
    if (ext === ".webp") return "public, max-age=31536000, immutable";
    if (ext === ".xml" || ext === ".txt") return "public, max-age=3600";
    return "public, max-age=3600";
}

function etag(buf) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < buf.length; i++) {
        h ^= buf[i];
        h = Math.imul(h, 16777619);
    }
    return 'W/"' + (h >>> 0).toString(16) + "-" + buf.length + '"';
}

function preCompress(buf) {
    return new Promise((resolve) => {
        const result = { raw: buf };

        try {
            zlib.brotliCompress(
                buf,
                {
                    params: {
                        [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
                        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
                    },
                },
                (err, br) => {
                    if (!err && br) result.br = br;

                    zlib.gzip(
                        buf,
                        {
                            level: 9,
                            windowBits: 15,
                            memLevel: 9,
                        },
                        (gzErr, gz) => {
                            if (!gzErr && gz) result.gz = gz;
                            resolve(result);
                        }
                    );
                }
            );
        } catch {
            zlib.gzip(buf, { level: 9 }, (gzErr, gz) => {
                if (!gzErr && gz) result.gz = gz;
                resolve(result);
            });
        }
    });
}

async function loadAndMinify(relPath, minify) {
    const abs = path.join(ROOT, relPath);
    const src = await fs.promises.readFile(abs);
    const originalContent = src.toString("utf8");

    if (relPath === "index.html") {
        extractInlineContent(originalContent);
    }

    const body = minify ? Buffer.from(minify(originalContent), "utf8") : src;
    const compressed = await preCompress(body);
    const stats = await fs.promises.stat(abs);

    const originalSize = src.length;
    const minifiedSize = body.length;
    const brSize = compressed.br?.length || 0;
    const gzSize = compressed.gz?.length || 0;

    console.log(`${relPath}:`);
    console.log(`  Original: ${originalSize} bytes`);
    if (minify)
        console.log(
            `  Minified: ${minifiedSize} bytes (${(
                ((originalSize - minifiedSize) / originalSize) *
                100
            ).toFixed(1)}% reduction)`
        );
    if (brSize)
        console.log(
            `  Brotli: ${brSize} bytes (${(
                (brSize / originalSize) *
                100
            ).toFixed(1)}% of original)`
        );
    if (gzSize)
        console.log(
            `  Gzip: ${gzSize} bytes (${((gzSize / originalSize) * 100).toFixed(
                1
            )}% of original)`
        );
    console.log("");

    const entry = {
        path: relPath,
        mtimeMs: stats.mtimeMs,
        type: contentTypeFor(relPath),
        cache: cacheControlFor(relPath),
        body,
        etag: etag(body),
        br: compressed.br,
        brEtag: compressed.br ? etag(compressed.br) : undefined,
        gz: compressed.gz,
        gzEtag: compressed.gz ? etag(compressed.gz) : undefined,
    };

    files.set("/" + relPath.replace(/\\/g, "/"), entry);
}

async function build() {
    console.log("Building and compressing files...\n");

    await loadAndMinify("index.html", minifyHTML);
    await loadAndMinify("style.css", minifyCSS);
    await loadAndMinify("script.js", minifyJS);

    for (const f of [
        "favicon.webp",
        "profile.webp",
        "robots.txt",
        "sitemap.xml",
    ]) {
        if (fs.existsSync(path.join(ROOT, f))) {
            await loadAndMinify(f, null);
        }
    }
    const cspPolicy = generateCSP();
    files.set("__csp__", cspPolicy);
}

function setSecurityHeaders(res) {
    const cspPolicy = files.get("__csp__");

    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("X-XSS-Protection", "1; mode=block");
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
    res.setHeader(
        "Strict-Transport-Security",
        "max-age=31536000; includeSubDomains; preload"
    );
    res.setHeader(
        "Permissions-Policy",
        "geolocation=(), microphone=(), camera=(), payment=(), usb=(), magnetometer=(), gyroscope=(), speaker=()"
    );

    if (cspPolicy) {
        res.setHeader("Content-Security-Policy", cspPolicy);
    }
}

function negotiateEncoding(req) {
    const ae = req.headers["accept-encoding"] || "";
    const hasBr = /\bbr\b/.test(ae);
    const hasGz = /\bgzip\b/.test(ae);
    return { br: hasBr, gz: hasGz };
}

function serveEntry(req, res, entry) {
    setSecurityHeaders(res);
    res.setHeader("Content-Type", entry.type);
    res.setHeader("Cache-Control", entry.cache);
    res.setHeader("Vary", "Accept-Encoding");

    const enc = negotiateEncoding(req);
    let body = entry.body;
    let tag = entry.etag;

    if (enc.br && entry.br) {
        body = entry.br;
        tag = entry.brEtag;
        res.setHeader("Content-Encoding", "br");
    } else if (enc.gz && entry.gz) {
        body = entry.gz;
        tag = entry.gzEtag;
        res.setHeader("Content-Encoding", "gzip");
    }

    res.setHeader("ETag", tag);
    if (req.headers["if-none-match"] === tag) {
        res.statusCode = 304;
        return res.end();
    }

    res.statusCode = 200;
    res.end(body);
}

function notFound(req, res) {
    setSecurityHeaders(res);
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("404 Not Found");
}

function handler(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let pathname = url.pathname;
    if (pathname === "/") pathname = "/index.html";
    const entry = files.get(pathname);
    if (entry) return serveEntry(req, res, entry);

    const fallback = path.join(ROOT, pathname);
    if (fs.existsSync(fallback) && fs.statSync(fallback).isFile()) {
        const raw = fs.readFileSync(fallback);
        const tmpEntry = {
            type: contentTypeFor(fallback),
            cache: cacheControlFor(fallback),
            body: raw,
            etag: etag(raw),
        };
        return serveEntry(req, res, tmpEntry);
    }

    return notFound(req, res);
}

async function start() {
    await build();
    const server = http.createServer(handler);
    server.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
    });
}

start().catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
});
