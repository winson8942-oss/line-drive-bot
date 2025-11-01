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

// === 通關密語 ===
const ACCESS_KEYWORD = process.env.ACCESS_KEYWORD || "解鎖備份";

// === 管理者 ID ===
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

  // 顯示目前使用的 Google 帳號
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
createGoogleClients()
  .then((d) => {
    drive = d;
    console.log("✅ Google Drive API ready");
    initWhitelist();
  })
  .catch((err) => console.error("❌ Google API init failed:", err));

// === 白名單初始化（從環境變數）===
let ALLOWED_USERS = [];
let ALLOWED_GROUPS = [];

function initWhitelist() {
  ALLOWED_USERS = process.env.ALLOWED_USERS
    ? process.env.ALLOWED_USERS.split(",").map((id) => id.trim())
    : [];
  ALLOWED_GROUPS = process.env.ALLOWED_GROUPS
    ? process.env.ALLOWED_GROUPS.split(",").map((id) => id.trim())
    : [];

  if (ADMIN_USER_ID && !ALLOWED_USERS.includes(ADMIN_USER_ID)) {
    ALLOWED_USERS.push(ADMIN_USER_ID);
  }

  console.log("📋 白名單載入完成");
  console.log("👤 Users:", ALLOWED_USERS);
  console.log("👥 Groups:", ALLOWED_GROUPS);
}

// === 暫存已授權名單（通關密語）===
const tempAuthorized = {
  users: new Set(),
  groups: new Set(),
};

// === 防止重複回覆 ===
const recentReplies = new Map();

// === Webhook ===
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500);
  }
});

// === 主事件處理 ===
async function handleEvent(event) {
  const msg = event.message;
  const sourceType = event.source.type;
  const userId = event.source.userId;
  const groupId = event.source.groupId;
  const replyToken = event.replyToken;

  // === 文字處理 ===
  if (msg?.type === "text") {
    const text = msg.text.trim();

    // 若未授權，檢查通關密語
    if (sourceType === "user" && !isAuthorized("user", userId)) {
      if (text === ACCESS_KEYWORD) {
        const profile = await client.getProfile(userId);
        tempAuthorized.users.add(userId);
        console.log(`✅ 通關成功（user）: ${profile.displayName}`);
        await client.replyMessage(replyToken, {
          type: "text",
          text: "✅ 通關成功！已啟用自動備份。",
        });
        return;
      } else return;
    }

    if (sourceType === "group" && !isAuthorized("group", groupId)) {
      if (text === ACCESS_KEYWORD) {
        const summary = await client.getGroupSummary(groupId);
        tempAuthorized.groups.add(groupId);
        console.log(`✅ 通關成功（group）: ${summary.groupName}`);
        await client.replyMessage(replyToken, {
          type: "text",
          text: "✅ 群組通關成功！已啟用自動備份。",
        });
        return;
      } else return;
    }
  }

  // === 白名單驗證 ===
  if (
    (sourceType === "user" && !isAuthorized("user", userId)) ||
    (sourceType === "group" && !isAuthorized("group", groupId))
  )
    return;

  // === 僅處理媒體 ===
  if (!["image", "video", "audio", "file"].includes(msg?.type)) return;

  await client.replyMessage(replyToken, { type: "text", text: "⏳正在存檔中..." });

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

  const now = new Date();
  const monthFolder = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const formatted = now.toISOString().replace("T", "_").replace(/:/g, "-").split(".")[0];
  const newFileName = `${formatted}_${fileName}`;

  const getOrCreateFolder = async (name, parentId = null) => {
    const q =
      `mimeType='application/vnd.google-apps.folder' and name='${name}' and trashed=false` +
      (parentId ? ` and '${parentId}' in parents` : "");
    const res = await drive.files.list({ q, fields: "files(id, name)" });
    if (res.data.files.length > 0) return res.data.files[0].id;
    const folder = await drive.files.create({
      resource: { name, mimeType: "application/vnd.google-apps.folder", parents: parentId ? [parentId] : [] },
      fields: "id",
    });
    return folder.data.id;
  };

  const baseFolder = process.env.GDRIVE_FOLDER_ID || null;
  const botFolder = await getOrCreateFolder("LINE-bot", baseFolder);
  const chatFolder = await getOrCreateFolder(folderName, botFolder);
  const monthFolderId = await getOrCreateFolder(monthFolder, chatFolder);

  try {
    const media = { body: fs.createReadStream(tempPath) };
    await drive.files.create({
      resource: { name: newFileName, parents: [monthFolderId] },
      media,
      fields: "id",
    });
    fs.unlinkSync(tempPath);
    console.log(`✅ 上傳完成: ${newFileName}`);

    const key = groupId || userId;
    const nowTime = Date.now();
    if (!recentReplies.has(key) || nowTime - recentReplies.get(key) > 60000) {
      recentReplies.set(key, nowTime);
      await client.pushMessage(key, { type: "text", text: "✅已自動存檔" });
    }
  } catch (err) {
    console.error("❌ 上傳失敗:", err);
  }
}

function isAuthorized(type, id) {
  if (type === "user") return ALLOWED_USERS.includes(id) || tempAuthorized.users.has(id);
  if (type === "group") return ALLOWED_GROUPS.includes(id) || tempAuthorized.groups.has(id);
  return false;
}

app.listen(3000, () => console.log("🚀 LINE Bot running on port 3000"));
