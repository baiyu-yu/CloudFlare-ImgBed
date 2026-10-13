export async function onRequest(context) {
    const { request, env, params } = context;

    if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // POST /imgbed-url-upload → 上传
    if (request.method === "POST") {
        const body = await request.text();
        const p = new URLSearchParams(body);

        // 鉴权
        if (env.AUTH_TOKEN) {
            let token = p.get("token") || request.headers.get("authorization") || "";
            token = token.replace(/^Bearer\s+/i, "");
            if (token !== env.AUTH_TOKEN) return json({ error: "Unauthorized" }, 401);
        }

        const imageUrl = p.get("image_url") || p.get("image") || "";
        if (!imageUrl) return json({ error: "缺少 image_url 参数" }, 400);

        let parsedUrl;
        try { parsedUrl = new URL(imageUrl); } catch { return json({ error: "URL 格式不合法" }, 400); }
        if (!["http:", "https:"].includes(parsedUrl.protocol)) return json({ error: "仅支持 http/https" }, 400);

        let imgResp;
        try {
            imgResp = await fetch(imageUrl, { headers: { "User-Agent": "CF-ImgBed/1.0" }, redirect: "follow" });
        } catch (e) { return json({ error: "拉取失败: " + String(e) }, 502); }
        if (!imgResp.ok) return json({ error: `来源返回 ${imgResp.status}` }, 502);

        const ct = imgResp.headers.get("content-type") || "image/jpeg";
        const ext = mimeToExt(ct) || extFromUrl(imageUrl) || "jpg";
        const filename = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;

        const bucket = env.img_r2 || env.img || env.BUCKET;
        if (!bucket) return json({ error: "R2 未绑定，请检查 Cloudflare Pages 绑定配置" }, 500);

        const buf = await imgResp.arrayBuffer();
        await bucket.put(filename, buf, { httpMetadata: { contentType: ct } });

        const host = new URL(request.url).origin;
        return json({ url: `${host}/imgbed-url-upload/${filename}`, filename });
    }

    // GET /imgbed-url-upload/<filename> → 读取图片
    if (request.method === "GET") {
        const key = Array.isArray(params.path) ? params.path.join("/") : (params.path || "");
        if (!key) return new Response("Not Found", { status: 404 });

        const bucket = env.img_r2 || env.img || env.BUCKET;
        if (!bucket) return new Response("R2 未绑定", { status: 500 });

        const object = await bucket.get(key);
        if (!object) return new Response("Not Found", { status: 404 });

        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set("cache-control", "public, max-age=31536000, immutable");
        headers.set("access-control-allow-origin", "*");
        return new Response(object.body, { headers });
    }

    return new Response("Method Not Allowed", { status: 405 });
}

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json;charset=UTF-8", ...corsHeaders() },
    });
}
function corsHeaders() {
    return { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS" };
}
function mimeToExt(mime) {
    return ({ "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif" })[(mime || "").split(";")[0].trim()] || null;
}
function extFromUrl(u) {
    try { const m = new URL(u).pathname.match(/\.(\w{2,5})$/); return m ? m[1] : null; } catch { return null; }
}
