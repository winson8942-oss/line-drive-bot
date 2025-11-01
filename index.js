import express from "express";
import line from "@line/bot-sdk";
import fs from "fs";
import { google } from "googleapis";

const app = express();

// === LINE BOT 設定 ===
const config = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);

// === 通關密語與管理者 ===
const ACCESS_KEYWORD = process.env.ACCESS_KEYWORD || "解鎖備份";
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || "";

// === Google OAuth 初始化 ===
async function createGoogleClients() {
  console.log("🔑 Using OAuth authentication...");

  const clientSecretData = JSON.parse(process.env.GOOGLE_CLIENT_SECRET_JSON);
  const tokenData = JSON.parse(process.env.GOOGLE_OAUTH_TOKEN_JSON);
  const creds = clientSecretData.installed || clientSecretData.web;

  if (!creds) throw new Error("❌ 找不到 client_secret.json 的 installed/web 欄位。");

  const { client_id, client_secret, redirect_uris } = creds;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  oAuth2Client.setCredentials(tokenData);

  try {
    const oauth2 = google.oauth2({ version: "v2", auth: oAuth2Client });
    const res = await oauth2.userinfo.get();
    console.log(`👤 使用的 Google 帳號: ${res.data.email}`);
  } catch {
    console.warn("⚠️ 無法讀取目前 OAuth 帳號（可能是 token 過期）");
  }

  return google.drive({ version: "v3", auth: oAuth2Client });
}

let drive;
let whitelistFileId = null;
let ALLOWED_USERS = [];
let ALLOWED_GROUPS = [];

// 初始化 Google Drive 與白名單
createGoogleClients()
  .then(async (d) => {
    drive = d;
    console.log("✅ Google Drive API ready");
    await loadWhitelist();
  })
  .catch((err) => console.error("❌ Google API init failed:", err));

// === 載入 / 建立 whitelist.json ===
async function loadWhitelist() {
  try {
    const botFolderId = await getOrCreateFolder("LINE-bot");
    const files = await drive.files.list({
      q: `'${botFolderId}' in parents and name='whitelist.json' and trashed=false`,
      fields: "files(id, name)",
    });

    let fileId;
    if (files.data.files.length === 0) {
      console.log("📄 未找到 whitelist.json，建立中...");
      const whitelistData = {
        users: ADMIN_USER_ID ? [ADMIN_USER_ID] : [],
        groups: [],
      };
      const media = {
        mimeType: "application/json",
        body: JSON.stringify(whitelistData, null, 2),
      };
      const file = await drive.files.create({
        resource: { name: "whitelist.json", parents: [botFolderId] },
        media,
        fields: "id",
      });
      fileId = file.data.id;
      console.log("✅ 已建立 whitelist.json:", fileId);
    } else {
      fileId = files.data.files[0].id;
      console.log("📄 已找到 whitelist.json");
    }

    const res = await drive.files.get({ fileId, alt: "media" });
    const data = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
    ALLOWED_USERS = data.users || [];
    ALLOWED_GROUPS = data.groups || [];
    whitelistFileId = fileId;

    console.log("📋 白名單載入完成");
  } catch (err) {
    console.error("❌ 讀取白名單失敗:", err);
  }
}

// === 儲存白名單 ===
async function saveWhitelist() {
  try {
    if (!whitelistFileId) return;
    const newData = { users: ALLOWED_USERS, groups: ALLOWED_GROUPS };
    const media = { mimeType: "application/json", body: JSON.stringify(newData, null, 2) };
    await drive.files.update({ fileId: whitelistFileId, media });
    console.log("💾 白名單已更新");
  } catch (err) {
    console.error("❌ 無法更新白名單:", err);
  }
}

// === 處理 LINE webhook ===
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500);
  }
});

async function handleEvent(event) {
  const msg = event.message;
  const sourceType = event.source.type;
  const userId = event.source.userId;
  const groupId = event.source.groupId;
  const replyToken = event.replyToken;

  // === 管理指令 ===
  if (msg?.type === "text" && userId === ADMIN_USER_ID) {
    const text = msg.text.trim();
    if (text === "白名單列表") {
      let reply = "👤 使用者：\n" + (ALLOWED_USERS.length ? ALLOWED_USERS.join("\n") : "(無)") +
                  "\n\n👥 群組：\n" + (ALLOWED_GROUPS.length ? ALLOWED_GROUPS.join("\n") : "(無)");
      await client.replyMessage(replyToken, { type: "text", text: reply });
      return;
    }
    if (text.startsWith("踢出 ")) {
      const target = text.replace("踢出 ", "").trim();
      if (target === "全部") {
        ALLOWED_USERS = [ADMIN_USER_ID];
        ALLOWED_GROUPS = [];
        await saveWhitelist();
        await client.replyMessage(replyToken, { type: "text", text: "⚠️ 已清空白名單（保留管理者）" });
        return;
      }
      const beforeUsers = ALLOWED_USERS.length, beforeGroups = ALLOWED_GROUPS.length;
      ALLOWED_USERS = ALLOWED_USERS.filter((id) => id !== target);
      ALLOWED_GROUPS = ALLOWED_GROUPS.filter((id) => id !== target);
      await saveWhitelist();
      const changed = beforeUsers !== ALLOWED_USERS.length || beforeGroups !== ALLOWED_GROUPS.length;
      await client.replyMessage(replyToken, { type: "text", text: changed ? `✅ 已從白名單移除 ${target}` : "❌ 找不到此 ID" });
      return;
    }
  }

  // === 通關密語 ===
  if (msg?.type === "text") {
    const text = msg.text.trim();
    if (sourceType === "user" && !isAuthorized("user", userId)) {
      if (text === ACCESS_KEYWORD) {
        ALLOWED_USERS.push(userId);
        await saveWhitelist();
        await client.replyMessage(replyToken, { type: "text", text: "✅ 通關成功！已加入永久白名單。" });
        return;
      } else return;
    }
    if (sourceType === "group" && !isAuthorized("group", groupId)) {
      if (text === ACCESS_KEYWORD) {
        ALLOWED_GROUPS.push(groupId);
        await saveWhitelist();
        await client.replyMessage(replyToken, { type: "text", text: "✅ 群組通關成功！已加入永久白名單。" });
        return;
      } else return;
    }
  }

  if (
    (sourceType === "user" && !isAuthorized("user", userId)) ||
    (sourceType === "group" && !isAuthorized("group", groupId))
  )
    return;

  if (!["image", "video", "audio", "file"].includes(msg?.type)) return;

  const messageId = msg.id;
  const ext =
    msg.type === "image"
      ? "jpg"
      : msg.type === "video"
      ? "mp4"
      : msg.type === "audio"
      ? "m4a"
      : "dat";
  const fileName = msg.fileName || `${messageId}.${ext}`;
  const tempPath = `/tmp/${fileName}`;

  const stream = await client.getMessageContent(messageId);
  await new Promise((resolve, reject) => {
    const writable = fs.createWriteStream(tempPath);
    stream.pipe(writable);
    writable.on("finish", resolve);
    writable.on("error", reject);
  });

  let folderName = "未知聊天室";
  try {
    if (sourceType === "group") {
      const summary = await client.getGroupSummary(groupId);
      folderName = summary.groupName || `Group-${groupId.slice(-4)}`;
    } else if (sourceType === "user") {
      const profile = await client.getProfile(userId);
      folderName = `User-${profile.displayName}`;
    }
  } catch {
    console.warn("⚠️ 無法取得名稱");
  }

  // === 台灣時間 UTC+8 命名 ===
  const now = new Date();
  const local = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const formatted = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, "0")}-${String(local.getDate()).padStart(2, "0")}_${String(local.getHours()).padStart(2, "0")}-${String(local.getMinutes()).padStart(2, "0")}-${String(local.getSeconds()).padStart(2, "0")}`;
  const newFileName = `${formatted}_${fileName}`;

  const botFolder = await getOrCreateFolder("LINE-bot");
  const chatFolder = await getOrCreateFolder(folderName, botFolder);

  try {
    const media = { body: fs.createReadStream(tempPath) };
    await drive.files.create({
      resource: { name: newFileName, parents: [chatFolder] },
      media,
      fields: "id",
    });
    fs.unlinkSync(tempPath);
    console.log(`✅ 上傳完成: ${newFileName}`);
    await client.replyMessage(replyToken, { type: "text", text: `✅存檔：${fileName}` });
  } catch (err) {
    console.error("❌ 上傳失敗:", err);
  }
}

function isAuthorized(type, id) {
  if (type === "user") return ALLOWED_USERS.includes(id);
  if (type === "group") return ALLOWED_GROUPS.includes(id);
  return false;
}

async function getOrCreateFolder(name, parentId = null) {
  const q = `mimeType='application/vnd.google-apps.folder' and name='${name}' and trashed=false` +
    (parentId ? ` and '${parentId}' in parents` : "");
  const res = await drive.files.list({ q, fields: "files(id, name)" });
  if (res.data.files.length > 0) return res.data.files[0].id;
  const folder = await drive.files.create({
    resource: { name, mimeType: "application/vnd.google-apps.folder", parents: parentId ? [parentId] : [] },
    fields: "id",
  });
  return folder.data.id;
}

app.listen(3000, () => console.log("🚀 LINE Bot running on port 3000"));
