/**
 * Cloudflare Pages Function: /imgbed-url-upload
 *
 * 接收 image_url 参数，由 Cloudflare 代拉图片后存入 R2，返回永久访问链接。
 * 与 aiplugin4 的 application/x-www-form-urlencoded 协议完全兼容。
 *
 * 需要的绑定（与 cf-imgbed 主项目共享同一个 R2）：
 *   - R2: 变量名 img，绑定你的 imgbed 存储桶
 *
 * 可选环境变量：
 *   - AUTH_TOKEN: 若设置则启用鉴权，请求需携带 token=<AUTH_TOKEN>
 */

export async function onRequestPost(context) {
    const { request, env } = context;
    return handleUpload(request, env);
}

// 也支持 OPTIONS 预检（跨域）
export async function onRequestOptions() {
    return new Response(null, {
        status: 204,
        headers: corsHeaders(),
    });
}

async function handleUpload(request, env) {
    // ── 鉴权（可选）──────────────────────────────────────────────────
    if (env.AUTH_TOKEN) {
        const body = await request.text();
        const params = new URLSearchParams(body);
        let token = params.get("token") || request.headers.get("authorization") || "";
        token = token.replace(/^Bearer\s+/i, "");
        if (token !== env.AUTH_TOKEN) {
            return json({ error: "Unauthorized" }, 401);
        }
        return await processUpload(params, env, request);
    }

    const body = await request.text();
    const params = new URLSearchParams(body);
    return await processUpload(params, env, request);
}

async function processUpload(params, env, request) {
    // ── 解析 image_url ───────────────────────────────────────────────
    const imageUrl = params.get("image_url") || params.get("image") || "";
    if (!imageUrl) {
        return json({ error: "缺少 image_url 参数" }, 400);
    }

    let parsedUrl;
    try {
        parsedUrl = new URL(imageUrl);
    } catch {
        return json({ error: "image_url 格式不合法" }, 400);
    }
    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        return json({ error: "仅支持 http/https" }, 400);
    }

    // ── 拉取图片 ─────────────────────────────────────────────────────
    let imageResp;
    try {
        imageResp = await fetch(imageUrl, {
            headers: { "User-Agent": "CF-ImgBed-UrlUpload/1.0" },
            redirect: "follow",
        });
    } catch (e) {
        return json({ error: "拉取图片失败: " + String(e) }, 502);
    }
    if (!imageResp.ok) {
        return json({ error: `来源服务器返回 ${imageResp.status}` }, 502);
    }

    // ── 推断格式 ─────────────────────────────────────────────────────
    const srcCt = imageResp.headers.get("content-type") || "image/jpeg";
    const ext = mimeToExt(srcCt) || extFromUrl(imageUrl) || "jpg";
    const timestamp = Date.now();
    const rand = Math.random().toString(36).slice(2, 8);
    const filename = `url-upload/${timestamp}_${rand}.${ext}`;

    // ── 存入 R2 ──────────────────────────────────────────────────────
    // cf-imgbed 绑定变量名为 img
    const bucket = env.img_r2 || env.img || env.BUCKET;
    if (!bucket) {
        return json({ error: "R2 存储桶未绑定，请检查 Cloudflare Pages 绑定配置" }, 500);
    }

    const imageBuffer = await imageResp.arrayBuffer();
    await bucket.put(filename, imageBuffer, {
        httpMetadata: { contentType: srcCt },
    });

    // ── 拼返回 URL ───────────────────────────────────────────────────
    const host = new URL(request.url).origin;
    const resultUrl = `${host}/file/${filename}`;

    return json({ url: resultUrl, filename });
}

// ── 工具函数 ─────────────────────────────────────────────────────────

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            "content-type": "application/json;charset=UTF-8",
            ...corsHeaders(),
        },
    });
}

function corsHeaders() {
    return {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "Content-Type, Authorization",
    };
}

function mimeToExt(mime) {
    const map = {
        "image/jpeg": "jpg",
        "image/jpg": "jpg",
        "image/png": "png",
        "image/gif": "gif",
        "image/webp": "webp",
        "image/avif": "avif",
        "image/svg+xml": "svg",
        "image/bmp": "bmp",
    };
    return map[(mime || "").split(";")[0].trim().toLowerCase()] || null;
}

function extFromUrl(rawUrl) {
    try {
        const p = new URL(rawUrl).pathname;
        const m = p.match(/\.(\w{2,5})$/);
        return m ? m[1] : null;
    } catch {
        return null;
    }
}

