const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

class AssetProcessor {
    constructor() {
        this.files = new Map();
        this.cspHashes = { scripts: new Set(), styles: new Set() };
    }

    hash(content, algorithm = "sha256") {
        return crypto
            .createHash(algorithm)
            .update(content, "utf8")
            .digest("base64");
    }

    etag(buf) {
        let h = 2166136261 >>> 0;
        for (let i = 0; i < buf.length; i++) {
            h ^= buf[i];
            h = Math.imul(h, 16777619);
        }
        return `W/"${(h >>> 0).toString(16)}-${buf.length}"`;
    }

    async compress(buf) {
        const result = { raw: buf };

        try {
            const [br, gz] = await Promise.all([
                new Promise((resolve) => {
                    zlib.brotliCompress(
                        buf,
                        {
                            params: {
                                [zlib.constants.BROTLI_PARAM_QUALITY]: 6,
                                [zlib.constants.BROTLI_PARAM_SIZE_HINT]:
                                    buf.length,
                            },
                        },
                        (err, compressed) => resolve(err ? null : compressed)
                    );
                }),
                new Promise((resolve) => {
                    zlib.gzip(buf, { level: 9 }, (err, compressed) =>
                        resolve(err ? null : compressed)
                    );
                }),
            ]);

            if (br) result.br = br;
            if (gz) result.gz = gz;
        } catch {}

        return result;
    }

    extractCSPHashes(html) {
        this.cspHashes.scripts.clear();
        this.cspHashes.styles.clear();

        (
            html.match(/<script(?![^>]*src=)[^>]*>([\s\S]*?)<\/script>/gi) || []
        ).forEach((match) => {
            const content = match.replace(/<\/?script[^>]*>/gi, "").trim();
            if (content) this.cspHashes.scripts.add(this.hash(content));
        });

        (html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || []).forEach(
            (match) => {
                const content = match.replace(/<\/?style[^>]*>/gi, "").trim();
                if (content) this.cspHashes.styles.add(this.hash(content));
            }
        );
    }

    generateCSP() {
        const scriptHashes = Array.from(this.cspHashes.scripts).map(
            (h) => `'sha256-${h}'`
        );
        const styleHashes = Array.from(this.cspHashes.styles).map(
            (h) => `'sha256-${h}'`
        );

        const scriptSrc = `'self'${
            scriptHashes.length ? " " + scriptHashes.join(" ") : ""
        }`;
        const styleSrc = `'self'${
            styleHashes.length
                ? " " + styleHashes.join(" ")
                : " 'unsafe-inline'"
        }`;

        return [
            "default-src 'self'",
            `script-src ${scriptSrc}`,
            `script-src-elem ${scriptSrc}`,
            `style-src ${styleSrc}`,
            `style-src-elem ${styleSrc}`,
            "img-src 'self' https: data:",
            "font-src 'self'",
            "connect-src 'self'",
            "media-src 'self' data:",
            "object-src 'none'",
            "child-src 'none'",
            "worker-src 'none'",
            "frame-ancestors 'none'",
            "form-action 'self'",
            "base-uri 'self'",
            "manifest-src 'self'",
            "upgrade-insecure-requests",
        ].join("; ");
    }

    minifyCSS(src) {
        return src
            .replace(/\/\*[\s\S]*?\*\//g, "")
            .replace(/\s+/g, " ")
            .replace(/\s*([{}:;,>+~\(\)\[\]'"*\/])\s*/g, "$1")
            .replace(/;}/g, "}")
            .replace(/\b0+(px|em|rem|vh|vw|%|s|ms)\b/g, "0")
            .replace(
                /#([0-9a-fA-F])\1([0-9a-fA-F])\2([0-9a-fA-F])\3\b/g,
                "#$1$2$3"
            )
            .replace(
                /rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/g,
                (m, r, g, b) => {
                    const hex = (n) =>
                        parseInt(n).toString(16).padStart(2, "0");
                    return `#${hex(r)}${hex(g)}${hex(b)}`;
                }
            )
            .replace(/,\s+/g, ",")
            .replace(/:\s+/g, ":")
            .replace(/;\s+/g, ";")
            .replace(/\{\s+/g, "{")
            .replace(/\s+\}/g, "}")
            .replace(/\r?\n/g, "")
            .trim();
    }

    minifyHTML(src) {
        return src
            .replace(/<!--(?!\[if)[\s\S]*?-->/g, "")
            .replace(/>\s+</g, "><")
            .replace(/>\s+([^<]+?)\s+</g, ">$1<")
            .replace(/<style[^>]*>([\s\S]*?)<\/style>/gi, (m, css) =>
                m.replace(css, this.minifyCSS(css))
            )
            .replace(/\s+([\w-]+)=["']([^"'\s<>]+)["']/g, (m, attr, val) =>
                /^[a-zA-Z0-9._:/-]+$/.test(val) ? ` ${attr}=${val}` : m
            )
            .replace(/\s*=\s*/g, "=")
            .replace(/\s+>/g, ">")
            .replace(/\s{2,}/g, " ")
            .replace(/\s+type=["']text\/(javascript|css)["']/g, "")
            .replace(/\r?\n/g, "")
            .trim();
    }

    minifyJS(src) {
        let out = src;
        const preserveStrings = [];
        let stringIndex = 0;

        out = out.replace(/(["'`])((?:\\.|(?!\1)[^\\])*?)\1/g, (match) => {
            const placeholder = `__STRING_${stringIndex++}__`;
            preserveStrings.push({ placeholder, original: match });
            return placeholder;
        });

        out = out.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

        out = out
            .replace(/\s+/g, " ")
            .replace(/\s*([=;:,{}()<>+\-*\/\?|&!])\s*/g, "$1")
            .replace(/;}/g, "}")
            .trim();

        preserveStrings.forEach(({ placeholder, original }) => {
            out = out.replace(placeholder, original);
        });

        return out;
    }

    getContentType(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        const types = {
            ".html": "text/html; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".webp": "image/webp",
            ".xml": "application/xml; charset=utf-8",
            ".txt": "text/plain; charset=utf-8",
        };
        return types[ext] || "application/octet-stream";
    }

    getCacheControl(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        if (ext === ".html") return "no-cache";
        if ([".css", ".js", ".webp"].includes(ext))
            return "public, max-age=31536000, immutable";
        return "public, max-age=3600";
    }

    async processFile(relPath, minifier = null) {
        const absPath = path.join(ROOT, relPath);
        const content = await fs.promises.readFile(absPath);
        const stats = await fs.promises.stat(absPath);

        let processedContent = content;

        if (relPath === "index.html") {
            let htmlContent = content.toString("utf8");

            const cssPath = path.join(ROOT, "style.css");
            if (fs.existsSync(cssPath)) {
                const cssContent = await fs.promises.readFile(cssPath, "utf8");
                htmlContent = htmlContent.replace(
                    /<link[^>]*href=["']style\.css["'][^>]*>/gi,
                    `<style>${this.minifyCSS(cssContent)}</style>`
                );
            }

            const jsPath = path.join(ROOT, "script.js");
            if (fs.existsSync(jsPath)) {
                const jsContent = await fs.promises.readFile(jsPath, "utf8");
                htmlContent = htmlContent.replace(
                    /<script[^>]*src=["']script\.js["'][^>]*><\/script>/gi,
                    `<script>${this.minifyJS(jsContent)}</script>`
                );
            }

            if (minifier) htmlContent = minifier(htmlContent);
            this.extractCSPHashes(htmlContent);
            processedContent = Buffer.from(htmlContent, "utf8");
        } else if (minifier) {
            processedContent = Buffer.from(
                minifier(content.toString("utf8")),
                "utf8"
            );
        }

        const compressed = await this.compress(processedContent);

        return {
            path: "/" + relPath.replace(/\\/g, "/"),
            mtimeMs: stats.mtimeMs,
            type: this.getContentType(relPath),
            cache: this.getCacheControl(relPath),
            body: processedContent,
            etag: this.etag(processedContent),
            br: compressed.br,
            brEtag: compressed.br ? this.etag(compressed.br) : undefined,
            gz: compressed.gz,
            gzEtag: compressed.gz ? this.etag(compressed.gz) : undefined,
        };
    }

    async build() {
        console.log("Building assets...");

        const tasks = [
            { file: "index.html", minifier: this.minifyHTML.bind(this) },
            { file: "style.css", minifier: this.minifyCSS.bind(this) },
            { file: "script.js", minifier: this.minifyJS.bind(this) },
            { file: "favicon.webp" },
            { file: "profile.webp" },
            { file: "robots.txt" },
            { file: "sitemap.xml" },
        ];

        await Promise.allSettled(
            tasks.map(async ({ file, minifier }) => {
                if (fs.existsSync(path.join(ROOT, file))) {
                    const entry = await this.processFile(file, minifier);
                    this.files.set(entry.path, entry);
                    return `${file}: processed`;
                }
                return `${file}: skipped`;
            })
        );

        this.files.set("__csp__", this.generateCSP());
        console.log("Build complete");
    }

    setSecurityHeaders(res) {
        const headers = {
            "X-Content-Type-Options": "nosniff",
            "X-Frame-Options": "DENY",
            "X-XSS-Protection": "1; mode=block",
            "Referrer-Policy": "strict-origin-when-cross-origin",
            "Strict-Transport-Security":
                "max-age=31536000; includeSubDomains; preload",
            "Permissions-Policy":
                "geolocation=(), microphone=(), camera=(), payment=(), usb=(), magnetometer=(), gyroscope=(), speaker=()",
            "Content-Security-Policy": this.files.get("__csp__"),
        };

        Object.entries(headers).forEach(([key, value]) => {
            if (value) res.setHeader(key, value);
        });
    }

    serveFile(req, res, entry) {
        this.setSecurityHeaders(res);
        res.setHeader("Content-Type", entry.type);
        res.setHeader("Cache-Control", entry.cache);
        res.setHeader("Vary", "Accept-Encoding");

        const acceptEncoding = req.headers["accept-encoding"] || "";
        let { body, etag: tag } = entry;

        if (/\bbr\b/.test(acceptEncoding) && entry.br) {
            body = entry.br;
            tag = entry.brEtag;
            res.setHeader("Content-Encoding", "br");
        } else if (/\bgzip\b/.test(acceptEncoding) && entry.gz) {
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

    handleRequest(req, res) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        let pathname = url.pathname === "/" ? "/index.html" : url.pathname;

        const entry = this.files.get(pathname);
        if (entry) return this.serveFile(req, res, entry);

        const fallbackPath = path.join(ROOT, pathname);
        if (fs.existsSync(fallbackPath) && fs.statSync(fallbackPath).isFile()) {
            const content = fs.readFileSync(fallbackPath);
            const tempEntry = {
                type: this.getContentType(fallbackPath),
                cache: this.getCacheControl(fallbackPath),
                body: content,
                etag: this.etag(content),
            };
            return this.serveFile(req, res, tempEntry);
        }

        this.setSecurityHeaders(res);
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("404 Not Found");
    }
}

async function start() {
    const processor = new AssetProcessor();
    await processor.build();

    const server = http.createServer((req, res) =>
        processor.handleRequest(req, res)
    );
    server.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
    });
}

start().catch((err) => {
    console.error("Server failed:", err);
    process.exit(1);
});
