import express from "express";
import crypto from "crypto";
import cors from "cors";
import { Telegraf } from "telegraf";

// --- фото: хранение file_id и прокси ---
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import multer from "multer";

// --- продукты: хранение в products.json ---
// (импорты НЕ повторяем)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PRODUCTS_DB = path.join(__dirname, "products.json");
let productsStore = [];
try { productsStore = JSON.parse(fs.readFileSync(PRODUCTS_DB, "utf8")); } catch {}
function saveProducts(){ fs.writeFileSync(PRODUCTS_DB, JSON.stringify(productsStore, null, 2)); }
function slugify(s){
  return String(s).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
}

// --- услуги: правки и удаления в services.json ---
const SERVICES_DB = path.join(__dirname, "services.json");
let servicesStore = { updates: {}, deleted: [] };
try {
  servicesStore = JSON.parse(fs.readFileSync(SERVICES_DB, "utf8"));
  if (!servicesStore || typeof servicesStore !== "object") servicesStore = { updates: {}, deleted: [] };
} catch {}
function saveServices(){
  fs.writeFileSync(SERVICES_DB, JSON.stringify(servicesStore, null, 2));
}


const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } }); // до 8MB

const PHOTOS_DB = path.join(__dirname, "photos.json");
let photosStore = {};
try { photosStore = JSON.parse(fs.readFileSync(PHOTOS_DB, "utf8")); } catch {}
function savePhotos() { fs.writeFileSync(PHOTOS_DB, JSON.stringify(photosStore, null, 2)); }


function userIdFromInitData(initData) {
  const p = new URLSearchParams(initData);
  try { return JSON.parse(p.get("user") || "{}")?.id ?? null; } catch { return null; }
}

// === admin ids & storage chat (ПЕРЕД любыми ссылками на них) ===
const ADMIN_CHAT_IDS = String(process.env.ADMIN_CHAT_IDS || "")
  .split(/\s*,\s*/).filter(Boolean);          // ["123", "456"]

function isAdmin(id) { return ADMIN_CHAT_IDS.includes(String(id)); }

const STORAGE_CHAT_ID = process.env.STORAGE_CHAT_ID
  ? String(process.env.STORAGE_CHAT_ID)
  : (ADMIN_CHAT_IDS[0] || null);

// ===== ENV =====
const PORT = process.env.PORT || 10000;
const BOT_TOKEN = process.env.BOT_TOKEN;                 // токен бота

// домены фронта (через запятую). Поддержим и ALLOWED_ORIGIN, и ALLOWED_ORIGINS
const ALLOWED_ORIGINS = String(process.env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGIN || "")
  .split(",").map(s => s.trim()).filter(Boolean);
const SERVER_URL = process.env.SERVER_URL;               // https://tma-den-serv.onrender.com
const SECRET_TOKEN = process.env.SECRET_TOKEN || "";     // секрет для вебхука
const WEBHOOK_PATH = "/tg-webhook";

// === anti-spam helpers ===
const _spam = new Map();
/** Разрешает не более `max` событий за окно `windowMs` по ключу `key`. */
function hitOk(key, windowMs = 30_000, max = 1) {
  const now = Date.now();
  const arr = _spam.get(key) || [];
  const fresh = arr.filter(t => now - t < windowMs);
  if (fresh.length >= max) return false;
  fresh.push(now);
  _spam.set(key, fresh);
  return true;
}



// ===== Express =====
const app = express();
app.use(express.json());

app.use(cors({
  origin: (origin, cb) => {
    if (!ALLOWED_ORIGINS.length || !origin) return cb(null, true);
    return ALLOWED_ORIGINS.includes(origin) ? cb(null, true) : cb(new Error("CORS"));
  }
}));

app.get("/", (_, res) => res.send("TMA backend is running"));

app.get("/me", (req, res) => {
  const initData = req.get("X-Telegram-Init-Data") || "";
  const ok = verifyInitData(initData, BOT_TOKEN);
  if (!ok) return res.status(403).json({ ok:false });
  const p = new URLSearchParams(initData);
  const user = p.get("user"); // строка JSON
  let uid = null; try { uid = JSON.parse(user)?.id; } catch {}
  return res.json({ ok:true, admin: isAdmin(String(uid)) });
});

// список фото по сервису
app.get("/photos/:serviceId", (req, res) => {
  const list = photosStore[req.params.serviceId] || [];
  // отдаём «проксированные» URL, чтобы не светить токен
  const items = list.map(fid => ({ file_id: fid, url: `/file/${encodeURIComponent(fid)}` }));
  res.json({ ok:true, items });
});

// прокси файла из Telegram, кэшируем file_path в памяти
const filePathCache = new Map();
app.get("/file/:fileId", async (req, res) => {
  try {
    const file_id = req.params.fileId;
    let file_path = filePathCache.get(file_id);
    if (!file_path) {
      const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile`, {
        method: "POST", headers: { "Content-Type":"application/json" },
        body: JSON.stringify({ file_id })
      });
      const j = await r.json();
      if (!j.ok) return res.sendStatus(404);
      file_path = j.result.file_path;
      filePathCache.set(file_id, file_path);
    }
    const tgResp = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${file_path}`);
    if (!tgResp.ok) return res.sendStatus(404);
    res.setHeader("Content-Type", tgResp.headers.get("content-type") || "image/jpeg");
    tgResp.body.pipe(res);
  } catch (e) {
    console.error(e);
    res.sendStatus(500);
  }
});

// загрузка фото админом
app.post("/photos/:serviceId", upload.single("photo"), async (req, res) => {
  try {
    const initData = req.get("X-Telegram-Init-Data") || "";
    if (!verifyInitData(initData, BOT_TOKEN)) return res.status(403).json({ ok:false, error:"bad initData" });

    const p = new URLSearchParams(initData);
    let uid = null; try { uid = JSON.parse(p.get("user")||"{}")?.id; } catch {}
    if (!isAdmin(String(uid))) return res.status(403).json({ ok:false, error:"not admin" });

    if (!req.file) return res.status(400).json({ ok:false, error:"no file" });
    if (!STORAGE_CHAT_ID) return res.status(500).json({ ok:false, error:"no STORAGE_CHAT_ID" });

    // шлём фото «на склад» (в твой чат/канал), берём file_id
    const form = new FormData();
    form.append("chat_id", STORAGE_CHAT_ID);
    form.append("caption", `#store service:${req.params.serviceId} ${new Date().toISOString()}`);
    form.append("disable_notification", "true");
    form.append("photo", new Blob([req.file.buffer]), "photo.jpg");

    const resp = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendPhoto`, { method:"POST", body: form });
    const data = await resp.json();
    if (!data.ok) return res.status(500).json({ ok:false, error:"sendPhoto failed" });
    const sizes = data.result.photo || [];
    const fid = sizes.at(-1)?.file_id; // самый большой
    if (!fid) return res.status(500).json({ ok:false, error:"no file_id" });

    photosStore[req.params.serviceId] = photosStore[req.params.serviceId] || [];
    photosStore[req.params.serviceId].unshift(fid);
    savePhotos();

    res.json({ ok:true, file_id: fid });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, error: e.message });
  }
});

// Приём «ручных» POST из фронта (опционально)
app.post("/web-data", async (req, res) => {
  const p = req.body || {};
  const key = p?.phone ? `leadPhone:${p.phone}` : `ip:${req.ip}`;
  if (!hitOk(key, 30_000, 1)) {
    return res.status(429).json({ ok:false, error:"Too Many Requests" });
  }
  const text = formatLead(p);
  try {
    await notifyAdmins(text);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post("/report-error", async (req, res) => {
  try {
    const initData = req.get("X-Telegram-Init-Data") || "";
    if (!verifyInitData(initData, BOT_TOKEN)) {
      return res.status(403).json({ ok:false, error:"bad initData" });
    }
    const uid = userIdFromInitData(initData) || req.ip;
    if (!hitOk(`er:${uid}`, 30_000, 1)) {
      return res.status(429).json({ ok:false, error:"Too Many Requests" });
    }


    const { details, debug } = req.body || {};
    const u = debug?.user;

    // Имя/юзер — БЕЗ кликабельной ссылки
    const who = u?.id
      ? esc(u.username ? `@${u.username} (id ${u.id})` : `${u.first_name || "Пользователь"} (id ${u.id})`)
      : "неизвестно";

    // Красивое форматирование, без поля URL
    const parts = [
      "🐞 <b>Отчёт об ошибке</b>",

      `👤 <b>Пользователь:</b> ${who}`,
      (debug?.platform || debug?.colorScheme)
        ? `📱 <b>Клиент:</b> ${esc(debug.platform || "-")} • Тема: ${esc(debug.colorScheme || "-")}`
        : null,
      debug?.appStep ? `🧭 <b>Шаг:</b> ${esc(debug.appStep)}` : null,

      debug?.selection
        ? `🧩 <b>Выбор:</b>\n<pre>${esc(JSON.stringify(debug.selection, null, 2)).slice(0, 1200)}</pre>`
        : null,

      details
        ? `📝 <b>Комментарий:</b>\n<pre>${esc(details).slice(0, 1500)}</pre>`
        : null,

      debug?.lastError?.message
        ? `⚠️ <b>Ошибка:</b> ${esc(debug.lastError.message)}`
        : null,

      debug?.lastError?.stack
        ? `🧵 <b>Стек:</b>\n<pre>${esc(String(debug.lastError.stack)).slice(0, 1800)}</pre>`
        : null,

      `⏱ <b>Время:</b> ${new Date(debug?.ts || Date.now()).toLocaleString("ru-RU")}`
    ].filter(Boolean);

    const msg = parts.join("\n\n");

    if (!ADMIN_CHAT_IDS.length) {
      return res.status(500).json({ ok:false, error:"ADMIN_CHAT_IDS is empty" });
    }

    await notifyAdmins(msg);
    res.json({ ok:true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false });
  }
});

app.post("/ask", async (req, res) => {
  try {
    const initData = req.get("X-Telegram-Init-Data") || "";
    if (!verifyInitData(initData, BOT_TOKEN)) {
      return res.status(403).json({ ok:false, error:"bad initData" });
    }
    const { text } = req.body || {};
    if (!text || String(text).trim().length < 2) {
      return res.status(400).json({ ok:false, error:"empty text" });
    }

    const p = new URLSearchParams(initData);
    let user = {}; try { user = JSON.parse(p.get("user") || "{}"); } catch {}
    const who = user?.username ? `@${user.username} (id ${user.id})`
              : user?.id ? `id ${user.id}` : "неизвестно";

    const msg =
      "❓ <b>Вопрос от пользователя</b>\n\n" +
      `👤 <b>Кто:</b> ${esc(who)}\n\n` +
      `📝 <b>Текст:</b>\n<pre>${esc(String(text)).slice(0,1500)}</pre>\n` +
      `⏱ ${new Date().toLocaleString("ru-RU")}`;

    await notifyAdmins(msg);
    res.json({ ok:true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false });
  }
});

// Получить правки/удаления услуг
app.get("/services", (req, res) => {
  res.json({ ok:true, updates: servicesStore.updates || {}, deleted: servicesStore.deleted || [] });
});

// Обновить (отредактировать) услугу по id
app.patch("/services/:id", async (req, res) => {
  try {
    const initData = req.get("X-Telegram-Init-Data") || "";
    if (!verifyInitData(initData, BOT_TOKEN)) return res.status(403).json({ ok:false, error:"bad initData" });

    const uid = userIdFromInitData(initData);
    if (!isAdmin(String(uid))) return res.status(403).json({ ok:false, error:"not admin" });

    const id = String(req.params.id);
    const { title, price_from, duration, desc } = req.body || {};
    const patch = {};
    if (typeof title === "string" && title.trim()) patch.title = title.trim();
    if (Number.isFinite(Number(price_from)) && Number(price_from) >= 0) patch.price_from = Number(price_from);
    if (typeof duration === "string") patch.duration = duration.trim();
    if (typeof desc === "string") patch.desc = desc.trim();

    if (!Object.keys(patch).length) return res.status(400).json({ ok:false, error:"empty patch" });

    servicesStore.updates[id] = { ...(servicesStore.updates[id] || {}), ...patch };
    // если услугу раньше пометили удалённой — снимаем пометку
    servicesStore.deleted = (servicesStore.deleted || []).filter(sid => sid !== id);
    saveServices();

    await notifyAdmins(`✏️ <b>Услуга изменена</b>\n<b>ID:</b> ${esc(id)}\n${patch.title ? `Название: <b>${esc(patch.title)}</b>\n` : ""}${patch.price_from!=null ? `От: <b>${patch.price_from} ₽</b>\n` : ""}${patch.duration ? `Время: <b>${esc(patch.duration)}</b>\n` : ""}`);
    res.json({ ok:true, id, patch: servicesStore.updates[id] });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, error:"server" });
  }
});

// Удалить (скрыть) услугу по id
app.delete("/services/:id", async (req, res) => {
  try {
    const initData = req.get("X-Telegram-Init-Data") || "";
    if (!verifyInitData(initData, BOT_TOKEN)) return res.status(403).json({ ok:false, error:"bad initData" });

    const uid = userIdFromInitData(initData);
    if (!isAdmin(String(uid))) return res.status(403).json({ ok:false, error:"not admin" });

    const id = String(req.params.id);
    servicesStore.deleted = Array.from(new Set([...(servicesStore.deleted || []), id]));
    if (servicesStore.updates[id]) delete servicesStore.updates[id];
    saveServices();

    await notifyAdmins(`🗑 <b>Услуга удалена</b>\n<b>ID:</b> ${esc(id)}`);
    res.json({ ok:true, id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok:false, error:"server" });
  }
});


// ===== Telegraf bot (вебхук) =====
if (!BOT_TOKEN) {
  console.warn("BOT_TOKEN is not set — бот отключён");
} else {
  const bot = new Telegraf(BOT_TOKEN, { handlerTimeout: 9000 });

  bot.command('id', (ctx) => {
    return ctx.reply(`Ваш chat_id: <code>${ctx.from.id}</code>`, { parse_mode: 'HTML' });
  });


  // данные из WebApp
  bot.on("message", async (ctx) => {
    const uid = ctx.from?.id || "anon";
    if (!hitOk(`lead:${uid}`, 30_000, 1)) {
      return ctx.reply("⏳ Пожалуйста, не чаще одного раза в 30 секунд.");
    }

    const raw = ctx.message?.web_app_data?.data;
    if (!raw) return;
    let p; try { p = JSON.parse(raw); } catch { return; }

    const text = formatLead(p, ctx.from);
    if (ADMIN_CHAT_IDS.length) {
      await Promise.all(ADMIN_CHAT_IDS.map(id =>
        ctx.telegram.sendMessage(id, text, { parse_mode: "HTML", disable_web_page_preview: true })
      ));
    }
    await ctx.reply("✅ Заявка принята, скоро свяжемся!");
  });

  // защищаем вебхук секретом
  app.use(WEBHOOK_PATH, (req, res, next) => {
    const got = req.get("x-telegram-bot-api-secret-token") || "";
    if (SECRET_TOKEN && got !== SECRET_TOKEN) return res.sendStatus(403);
    return bot.webhookCallback(WEBHOOK_PATH)(req, res);
  });

  // ставим вебхук на старте (если указан SERVER_URL)
  (async () => {
    try {
      if (SERVER_URL) {
        await bot.telegram.setWebhook(`${SERVER_URL}${WEBHOOK_PATH}`, { secret_token: SECRET_TOKEN });
        console.log("Webhook set:", `${SERVER_URL}${WEBHOOK_PATH}`);
      } else {
        const info = await bot.telegram.getWebhookInfo();
        console.log("Webhook info:", info);
      }
    } catch (e) {
      console.error("setWebhook error:", e.response?.description || e.message);
    }
  })();
}

app.listen(PORT, () => console.log(`Server running on ${PORT}`));

// ===== helpers =====
function esc(s = "") { return String(s).replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c])); }
function formatLead(p, from) {
  return [
    `<b>Новая заявка</b>`,
    p.category ? `Категория: <b>${esc(p.category)}</b>` : null,
    (p.brand || p.model) ? `Марка/модель: <b>${esc(p.brand||"")} ${esc(p.model||"")}</b>` : null,
    p.service ? `Услуга: <b>${esc(p.service)}</b>` : null,
    p.price_from ? `От: <b>${p.price_from} ₽</b>` : null,
    p.name ? `Имя: <b>${esc(p.name)}</b>` : null,
    p.phone ? `Телефон: <b>${esc(p.phone)}</b>` : null,
    p.city ? `Город: <b>${esc(p.city)}</b>` : null,
    p.comment ? `Комментарий: ${esc(p.comment)}` : null,
    from ? `\nОт: <a href="tg://user?id=${from.id}">${esc(from.username ? "@"+from.username : from.first_name || "user")}</a>` : null,
    `Время: ${new Date(p.ts || Date.now()).toLocaleString("ru-RU")}`
  ].filter(Boolean).join("\n");
}

function verifyInitData(initData, botToken) {
  if (!initData || !botToken) return false;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return false;

  const data = [];
  params.forEach((v, k) => { if (k !== "hash") data.push(`${k}=${v}`); });
  data.sort();
  const dataCheckString = data.join("\n");

  const secret = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
  const calc = crypto.createHmac("sha256", secret).update(dataCheckString).digest("hex");

  const authDate = Number(params.get("auth_date") || "0");
  const fresh = !authDate || (Date.now()/1000 - authDate) < 24*60*60; // не старше суток

  return calc === hash && fresh;
}

async function notifyAdmins(text, tg) {
  // отправка через Telegram HTTP API (без зависимости от контекста Telegraf)
  await Promise.all(ADMIN_CHAT_IDS.map(id =>
    fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: id, text, parse_mode: "HTML", disable_web_page_preview: true })
    })
  ));
}
