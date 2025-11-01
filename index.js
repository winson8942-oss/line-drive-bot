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

// === Google Drive 初始化 ===
async function createDriveClient() {
  if (process.env.GDRIVE_AUTH_MODE === "oauth") {
    console.log("🔑 Using OAuth authentication...");
    const clientSecretData = JSON.parse(process.env.GOOGLE_CLIENT_SECRET_JSON);
    const tokenData = JSON.parse(process.env.GOOGLE_OAUTH_TOKEN_JSON);
    const creds = clientSecretData.installed || clientSecretData.web;
    if (!creds) throw new Error("Invalid client_secret.json format.");

    const { client_id, client_secret, redirect_uris } = creds;
    const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
    oAuth2Client.setCredentials(tokenData);
    return google.drive({ version: "v3", auth: oAuth2Client });
  } else {
    console.log("🔐 Using Service Account authentication...");
    const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    if (!serviceAccount.client_email)
      throw new Error("Service Account JSON missing client_email field");

    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccount,
      scopes: ["https://www.googleapis.com/auth/drive.file"],
    });
    const authClient = await auth.getClient();
    return google.drive({ version: "v3", auth: authClient });
  }
}

let drive;
createDriveClient()
  .then((c) => {
    drive = c;
    console.log("✅ Google Drive client ready");
  })
  .catch((err) => console.error("❌ Drive init failed:", err));

// === 白名單：從 Google Sheet 載入 ===
let ALLOWED_USERS = [];
let ALLOWED_GROUPS = [];

// 讀取 Google Sheet 白名單
async function loadWhitelistFromSheet() {
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });
    const sheets = google.sheets({ version: "v4", auth });
    const sheetId = process.env.WHITELIST_SHEET_ID;

    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: "Sheet1!A2:B", // 跳過標題列
    });

    const rows = res.data.values || [];
    const userList = [];
    const groupList = [];

    rows.forEach(([type, id]) => {
      if (type === "user") userList.push(id.trim());
      if (type === "group") groupList.push(id.trim());
    });

    ALLOWED_USERS = userList;
    ALLOWED_GROUPS = groupList;

    console.log("📄 讀取 Google Sheet 白名單成功");
    console.log("👤 Users:", ALLOWED_USERS);
    console.log("👥 Groups:", ALLOWED_GROUPS);
  } catch (err) {
    console.error("❌ 無法讀取 Google Sheet 白名單:", err);
  }
}

// 初次載入白名單
loadWhitelistFromSheet();

// 每 5 分鐘自動更新一次白名單
setInterval(loadWhitelistFromSheet, 5 * 60 * 1000);

// === 防止群組重複回覆記錄 ===
const recentReplies = new Map(); // key = groupId / roomId, value = timestamp

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

// === 主處理函式 ===
async function handleEvent(event) {
  console.log("🪪 event.source:", event.source);

  if (event.type !== "message") return;
  const msg = event.message;
  const sourceType = event.source.type;
  const userId = event.source.userId;
  const groupId = event.source.groupId;

  // === 白名單驗證 ===
  if (
    (sourceType === "user" && !ALLOWED_USERS.includes(userId)) ||
    (sourceType === "group" && !ALLOWED_GROUPS.includes(groupId))
  ) {
    console.log("🚫 未授權使用者或群組，已靜默忽略。");
    return; // ⚠️ 靜默模式，不回覆
  }

  // === 僅處理可下載媒體 ===
  if (!["image", "video", "audio", "file"].includes(msg.type)) return;

  await client.replyMessage(event.replyToken, {
    type: "text",
    text: "⏳正在存檔中...",
  });

  // === 檔案下載 ===
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

  // === 群組 / 使用者名稱分類 ===
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
    console.warn("⚠️ 無法取得聊天室名稱，使用預設名稱。");
  }

  // === 日期命名 ===
  const now = new Date();
  const formattedDate = now.toISOString().replace("T", "_").replace(/:/g, "-").split(".")[0];
  const monthFolderName = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const newFileName = `${formattedDate}_${fileName}`;

  // === Google Drive 建立層級資料夾 ===
  const getOrCreateFolder = async (name, parentId = null) => {
    const q =
      `mimeType='application/vnd.google-apps.folder' and name='${name}' and trashed=false` +
      (parentId ? ` and '${parentId}' in parents` : "");
    const res = await drive.files.list({ q, fields: "files(id, name)" });
    if (res.data.files.length > 0) return res.data.files[0].id;
    const folder = await drive.files.create({
      resource: {
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: parentId ? [parentId] : [],
      },
      fields: "id",
    });
    console.log(`📁 Created folder: ${name}`);
    return folder.data.id;
  };

  const baseFolderId = process.env.GDRIVE_FOLDER_ID || null;
  const botFolderId = await getOrCreateFolder("LINE-bot", baseFolderId);
  const chatFolderId = await getOrCreateFolder(folderName, botFolderId);
  const monthFolderId = await getOrCreateFolder(monthFolderName, chatFolderId);

  // === 上傳到 Google Drive ===
  try {
    const media = { body: fs.createReadStream(tempPath) };
    await drive.files.create({
      resource: { name: newFileName, parents: [monthFolderId] },
      media,
      fields: "id",
    });
    console.log(`📂 Uploaded: ${newFileName}`);

    fs.unlinkSync(tempPath); // 自動刪除暫存檔
    console.log(`🧹 Temp deleted: ${tempPath}`);

    const key = groupId || userId;
    const nowTime = Date.now();
    if (!recentReplies.has(key) || nowTime - recentReplies.get(key) > 60000) {
      recentReplies.set(key, nowTime);
      const replyTarget = userId || groupId;
      await client.pushMessage(replyTarget, {
        type: "text",
        text: "✅已自動存檔",
      });
    }
  } catch (err) {
    console.error("❌ Upload failed:", err);
    await client.pushMessage(userId || groupId, {
      type: "text",
      text: "上傳失敗，請稍後再試。",
    });
  }
}

app.listen(3000, () => console.log("🚀 LINE Bot running on port 3000"));
