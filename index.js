// ======================================================
// 🚀 LINE Drive Bot v13.0 - Google / OneDrive 雙雲端備份
// ======================================================
import express from "express";
import line from "@line/bot-sdk";
import fs from "fs";
import { google } from "googleapis";
import { Client as MsClient } from "@microsoft/microsoft-graph-client";
import "isomorphic-fetch";

const app = express();

// --- LINE 設定 ---
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);

// --- 系統參數 ---
const DRIVE_MODE = (process.env.DRIVE_MODE || "google").toLowerCase(); // google | onedrive | both
const ACCESS_KEYWORD = process.env.ACCESS_KEYWORD || "解鎖備份";
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || "";
const BOT_ROOT = "LINE-bot";
const BATCH_MS = 2000;

// --- 暫存上傳列表（2 秒合併訊息）---
const uploadBuffer = new Map();

// ===============================
// ⏰ 時間字串 (+8 台灣時區)
// ===============================
function tsPrefix() {
  const now = new Date();
  const local = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const y = local.getFullYear();
  const m = String(local.getMonth() + 1).padStart(2, "0");
  const d = String(local.getDate()).padStart(2, "0");
  const hh = String(local.getHours()).padStart(2, "0");
  const mm = String(local.getMinutes()).padStart(2, "0");
  const ss = String(local.getSeconds()).padStart(2, "0");
  return `${y}-${m}-${d}_${hh}-${mm}-${ss}`;
}

// ===============================
// 🧩 批次回覆處理
// ===============================
function scheduleReply(chatId, replyToken, name, type) {
  let buf = uploadBuffer.get(chatId);
  if (!buf) {
    buf = { items: [], timer: null, lastReplyToken: replyToken };
    uploadBuffer.set(chatId, buf);
  }
  buf.items.push({ name, type });
  buf.lastReplyToken = replyToken;

  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(async () => {
    const { items, lastReplyToken } = buf;
    if (!items.length) return;
    const grouped = { image: [], video: [], audio: [], file: [] };
    for (const it of items) (grouped[it.type] || grouped.file).push(it.name);
    let text = "✅ 已自動存檔：";
    if (grouped.image.length)
      text += "\n\n🖼️ 圖片：\n" + grouped.image.map((n) => `- ${n}`).join("\n");
    if (grouped.video.length)
      text += "\n\n🎬 影片：\n" + grouped.video.map((n) => `- ${n}`).join("\n");
    if (grouped.audio.length)
      text += "\n\n🎵 音訊：\n" + grouped.audio.map((n) => `- ${n}`).join("\n");
    if (grouped.file.length)
      text += "\n\n📄 檔案：\n" + grouped.file.map((n) => `- ${n}`).join("\n");
    try {
      await client.replyMessage(lastReplyToken, { type: "text", text });
    } catch (e) {
      console.error("Reply failed:", e?.response?.data || e);
    }
    uploadBuffer.delete(chatId);
  }, BATCH_MS);
}

// ===============================
// ☁️ Google Drive
// ===============================
let drive = null;
let whitelistFileId = null;

async function initGoogle() {
  const cs = JSON.parse(process.env.GOOGLE_CLIENT_SECRET_JSON);
  const tk = JSON.parse(process.env.GOOGLE_OAUTH_TOKEN_JSON);
  const creds = cs.installed || cs.web;
  const { client_id, client_secret, redirect_uris } = creds;
  const oauth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  oauth.setCredentials(tk);
  drive = google.drive({ version: "v3", auth: oauth });
  console.log("✅ Google Drive ready");
}

async function getOrCreateFolder_G(name, parentId = null) {
  const q = `mimeType='application/vnd.google-apps.folder' and name='${name.replace(/'/g, "\\'")}' and trashed=false` +
    (parentId ? ` and '${parentId}' in parents` : "");
  const r = await drive.files.list({ q, fields: "files(id,name)" });
  if (r.data.files.length) return r.data.files[0].id;
  const f = await drive.files.create({
    resource: { name, mimeType: "application/vnd.google-apps.folder", parents: parentId ? [parentId] : [] },
    fields: "id",
  });
  return f.data.id;
}

async function ensureWhitelist_G() {
  const botId = await getOrCreateFolder_G(BOT_ROOT);
  const r = await drive.files.list({
    q: `'${botId}' in parents and name='whitelist.json' and trashed=false`,
    fields: "files(id,name)",
  });
  if (!r.data.files.length) {
    const init = { users: ADMIN_USER_ID ? [ADMIN_USER_ID] : [], groups: [] };
    const f = await drive.files.create({
      resource: { name: "whitelist.json", parents: [botId] },
      media: { mimeType: "application/json", body: JSON.stringify(init, null, 2) },
      fields: "id",
    });
    whitelistFileId = f.data.id;
  } else whitelistFileId = r.data.files[0].id;
}

async function loadWhitelist_G() {
  const res = await drive.files.get({ fileId: whitelistFileId, alt: "media" });
  const data = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
  return { users: data.users || [], groups: data.groups || [] };
}

async function saveWhitelist_G(users, groups) {
  const body = JSON.stringify({ users, groups }, null, 2);
  await drive.files.update({
    fileId: whitelistFileId,
    media: { mimeType: "application/json", body },
  });
}

async function uploadToGoogle(folderName, newFileName, tmpPath) {
  const botId = await getOrCreateFolder_G(BOT_ROOT);
  const chatId = await getOrCreateFolder_G(folderName, botId);
  let finalName = newFileName, idx = 1;
  while (true) {
    const r = await drive.files.list({
      q: `'${chatId}' in parents and name='${finalName}' and trashed=false`,
      fields: "files(id,name)",
    });
    if (!r.data.files.length) break;
    const dot = newFileName.lastIndexOf(".");
    const base = dot > 0 ? newFileName.slice(0, dot) : newFileName;
    const ext = dot > 0 ? newFileName.slice(dot) : "";
    finalName = `${base}_${idx}${ext}`; idx++;
  }
  await drive.files.create({
    resource: { name: finalName, parents: [chatId] },
    media: { body: fs.createReadStream(tmpPath) },
    fields: "id",
  });
}

// ===============================
// ☁️ OneDrive (Microsoft Graph)
// ===============================
let graph = null;

async function initOneDrive() {
  async function refreshToken() {
    const tenant = process.env.ONEDRIVE_TENANT_ID || "common";
    const cid = process.env.ONEDRIVE_CLIENT_ID;
    const csec = process.env.ONEDRIVE_CLIENT_SECRET;
    const refresh = process.env.ONEDRIVE_REFRESH_TOKEN;
    const params = new URLSearchParams();
    params.append("client_id", cid);
    params.append("client_secret", csec);
    params.append("grant_type", "refresh_token");
    params.append("refresh_token", refresh);
    params.append("scope", "Files.ReadWrite User.Read offline_access");
    const resp = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      method: "POST", body: params,
    });
    const data = await resp.json();
    if (!data.access_token)
      throw new Error("OneDrive token refresh failed: " + JSON.stringify(data));
    return data.access_token;
  }
  const accessToken = await refreshToken();
  graph = MsClient.init({ authProvider: (done) => done(null, accessToken) });
  console.log("✅ OneDrive ready");
}

function enc(s) { return encodeURIComponent(s).replace(/%2F/g, "%2F"); }

async function ensurePath_OD(parts) {
  let curr = "";
  for (const p of parts) {
    curr = curr ? `${curr}/${p}` : p;
    try { await graph.api(`/me/drive/root:/${enc(curr)}`).get(); }
    catch { await graph.api(`/me/drive/root:/${enc(curr)}`).put({ folder: {}, "@microsoft.graph.conflictBehavior": "rename" }); }
  }
}

async function exists_OD(path) {
  try { await graph.api(`/me/drive/root:/${enc(path)}`).get(); return true; }
  catch { return false; }
}

async function uploadToOneDrive(folderName, newFileName, tmpPath) {
  await ensurePath_OD([BOT_ROOT, folderName]);
  let finalName = newFileName, idx = 1;
  const basePath = `${BOT_ROOT}/${folderName}`;
  while (await exists_OD(`${basePath}/${finalName}`)) {
    const dot = newFileName.lastIndexOf(".");
    const base = dot > 0 ? newFileName.slice(0, dot) : newFileName;
    const ext = dot > 0 ? newFileName.slice(dot) : "";
    finalName = `${base}_${idx}${ext}`; idx++;
  }
  await graph.api(`/me/drive/root:/${enc(basePath)}/${enc(finalName)}:/content`)
    .put(fs.createReadStream(tmpPath));
}

// ===============================
// 🔐 白名單
// ===============================
let ALLOWED_USERS = [], ALLOWED_GROUPS = [];

async function ensureWhitelist() {
  if (DRIVE_MODE === "google" || DRIVE_MODE === "both") {
    await initGoogle(); await ensureWhitelist_G();
    const w = await loadWhitelist_G();
    ALLOWED_USERS = w.users; ALLOWED_GROUPS = w.groups;
  }
  if (DRIVE_MODE === "onedrive") {
    await initOneDrive();
    if (!ALLOWED_USERS.length && ADMIN_USER_ID) ALLOWED_USERS = [ADMIN_USER_ID];
  }
}

function isAuth(kind, id) {
  return kind === "user" ? ALLOWED_USERS.includes(id) : ALLOWED_GROUPS.includes(id);
}

// ===============================
// 🧠 LINE Webhook
// ===============================
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error:", e?.response?.data || e);
    res.sendStatus(500);
  }
});

function chatKey(e) {
  return e.source.groupId || e.source.userId || e.source.roomId || "unknown";
}

async function handleEvent(event) {
  const msg = event.message;
  const type = msg?.type;
  const srcType = event.source.type;
  const userId = event.source.userId;
  const groupId = event.source.groupId;
  const replyToken = event.replyToken;

  // === 管理員指令 ===
  if (type === "text" && userId === ADMIN_USER_ID) {
    const text = msg.text.trim();
    if (text === "白名單列表") {
      const reply = `👤 使用者：\n${ALLOWED_USERS.join("\n") || "(無)"}\n\n👥 群組：\n${ALLOWED_GROUPS.join("\n") || "(無)"}`;
      await client.replyMessage(replyToken, { type: "text", text: reply }); return;
    }
    if (text.startsWith("踢出 ")) {
      const target = text.replace("踢出 ", "").trim();
      if (target === "全部") {
        ALLOWED_USERS = [ADMIN_USER_ID]; ALLOWED_GROUPS = [];
        if (drive) await saveWhitelist_G(ALLOWED_USERS, ALLOWED_GROUPS);
        await client.replyMessage(replyToken, { type: "text", text: "⚠️ 已清空白名單（保留管理者）" });
        return;
      }
      ALLOWED_USERS = ALLOWED_USERS.filter(id => id !== target);
      ALLOWED_GROUPS = ALLOWED_GROUPS.filter(id => id !== target);
      if (drive) await saveWhitelist_G(ALLOWED_USERS, ALLOWED_GROUPS);
      await client.replyMessage(replyToken, { type: "text", text: `✅ 已從白名單移除 ${target}` });
      return;
    }
  }

  // === 通關密語 ===
  if (type === "text") {
    const text = msg.text.trim();
    if (srcType === "user" && !isAuth("user", userId)) {
      if (text === ACCESS_KEYWORD) {
        ALLOWED_USERS.push(userId);
        if (drive) await saveWhitelist_G(ALLOWED_USERS, ALLOWED_GROUPS);
        await client.replyMessage(replyToken, { type: "text", text: "✅ 通關成功！已加入永久白名單。" });
      }
      return;
    }
    if (srcType === "group" && !isAuth("group", groupId)) {
      if (text === ACCESS_KEYWORD) {
        ALLOWED_GROUPS.push(groupId);
        if (drive) await saveWhitelist_G(ALLOWED_USERS, ALLOWED_GROUPS);
        await client.replyMessage(replyToken, { type: "text", text: "✅ 群組通關成功！已加入永久白名單。" });
      }
      return;
    }
  }

  // === 權限 / 檔案處理 ===
  if ((srcType === "user" && !isAuth("user", userId)) ||
      (srcType === "group" && !isAuth("group", groupId))) return;
  if (!["image", "video", "audio", "file"].includes(type)) return;

  const messageId = msg.id;
  const ext = type === "image" ? "jpg" : type === "video" ? "mp4" : type === "audio" ? "m4a" : "dat";
  const fileName = msg.fileName || `${messageId}.${ext}`;
  const tmp = `/tmp/${fileName}`;
  const stream = await client.getMessageContent(messageId);
  await new Promise((resolve, reject) => {
    const w = fs.createWriteStream(tmp);
    stream.pipe(w);
    w.on("finish", resolve);
    w.on("error", reject);
  });

  let folderName = "未知聊天室";
  try {
    if (srcType === "group") {
      const s = await client.getGroupSummary(groupId);
      folderName = s.groupName || `Group-${groupId.slice(-4)}`;
    } else {
      const p = await client.getProfile(userId);
      folderName = `User-${p.displayName}`;
    }
  } catch {}

  const newFileName = `${tsPrefix()}_${fileName}`;

  try {
    if (DRIVE_MODE === "google" || DRIVE_MODE === "both")
      await uploadToGoogle(folderName, newFileName, tmp);
    if (DRIVE_MODE === "onedrive" || DRIVE_MODE === "both") {
      if (!graph) await initOneDrive();
      await uploadToOneDrive(folderName, newFileName, tmp);
    }
    fs.unlinkSync(tmp);
    const key = chatKey(event);
    scheduleReply(key, replyToken, fileName, type);
  } catch (e) {
    console.error("Upload failed:", e?.response?.data || e);
  }
}

// ===============================
// 🚀 啟動服務
// ===============================
ensureWhitelist()
  .then(() => {
    app.listen(3000, () => console.log("🚀 v13.0 dual-cloud running on 3000"));
  })
  .catch((e) => {
    console.error("Init failed:", e);
    app.listen(3000, () => console.log("🚀 v13.0 dual-cloud started (with warnings)"));
  });
