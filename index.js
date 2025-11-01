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

// === Google Drive 初始化 ===
async function createDriveClient() {
  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  if (!serviceAccount.client_email)
    throw new Error("Service Account JSON missing client_email field");

  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: [
      "https://www.googleapis.com/auth/drive.file",
      "https://www.googleapis.com/auth/spreadsheets",
    ],
  });
  const authClient = await auth.getClient();
  return {
    drive: google.drive({ version: "v3", auth: authClient }),
    sheets: google.sheets({ version: "v4", auth: authClient }),
  };
}

let drive, sheets;
createDriveClient()
  .then((c) => {
    drive = c.drive;
    sheets = c.sheets;
    console.log("✅ Google APIs ready");
  })
  .catch((err) => console.error("❌ Google API init failed:", err));

// === 白名單 ===
let ALLOWED_USERS = [];
let ALLOWED_GROUPS = [];

// === 從 Google Sheet 載入白名單 ===
async function loadWhitelistFromSheet() {
  try {
    const sheetId = process.env.WHITELIST_SHEET_ID;
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: "Sheet1!A2:B",
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

    console.log("📄 白名單已同步");
    console.log("👤 Users:", ALLOWED_USERS);
    console.log("👥 Groups:", ALLOWED_GROUPS);
  } catch (err) {
    console.error("❌ 讀取白名單失敗:", err);
  }
}
loadWhitelistFromSheet();
setInterval(loadWhitelistFromSheet, 5 * 60 * 1000); // 每 5 分鐘更新

// === 寫入 Google Sheet（通關成功時） ===
async function addToWhitelist(type, id) {
  try {
    const sheetId = process.env.WHITELIST_SHEET_ID;
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: "Sheet1!A:B",
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[type, id]] },
    });
    console.log(`✅ 已寫入白名單 (${type}): ${id}`);
  } catch (err) {
    console.error("❌ 寫入白名單失敗:", err);
  }
}

// === 防止群組重複回覆 ===
const recentReplies = new Map();

app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500);
  }
});

// === 主處理邏輯 ===
async function handleEvent(event) {
  console.log("🪪 event.source:", event.source);
  const msg = event.message;
  const sourceType = event.source.type;
  const userId = event.source.userId;
  const groupId = event.source.groupId;
  const replyToken = event.replyToken;

  // === 若為文字訊息，檢查通關密語 ===
  if (msg?.type === "text") {
    const text = msg.text.trim();

    // 1️⃣ 個人通關
    if (sourceType === "user" && !ALLOWED_USERS.includes(userId)) {
      if (text === ACCESS_KEYWORD) {
        await addToWhitelist("user", userId);
        ALLOWED_USERS.push(userId);
        await client.replyMessage(replyToken, {
          type: "text",
          text: "✅ 通關成功！已啟用自動備份功能。",
        });
        return;
      } else {
        console.log("🚫 未授權使用者（密語錯誤）");
        return; // 靜默忽略
      }
    }

    // 2️⃣ 群組通關
    if (sourceType === "group" && !ALLOWED_GROUPS.includes(groupId)) {
      if (text === ACCESS_KEYWORD) {
        await addToWhitelist("group", groupId);
        ALLOWED_GROUPS.push(groupId);
        await client.replyMessage(replyToken, {
          type: "text",
          text: "✅ 群組通關成功！已啟用自動備份功能。",
        });
        return;
      } else {
        console.log("🚫 未授權群組（密語錯誤）");
        return;
      }
    }
  }

  // === 白名單驗證 ===
  if (
    (sourceType === "user" && !ALLOWED_USERS.includes(userId)) ||
    (sourceType === "group" && !ALLOWED_GROUPS.includes(groupId))
  ) {
    console.log("🚫 未授權來源，靜默忽略。");
    return;
  }

  // === 僅處理媒體 / 檔案 ===
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

  // === 群組或使用者資料夾名稱 ===
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
    console.warn("⚠️ 無法取得聊天室名稱。");
  }

  // === 建立 Drive 資料夾結構 ===
  const now = new Date();
  const formattedDate = now.toISOString().replace("T", "_").replace(/:/g, "-").split(".")[0];
  const monthFolderName = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const newFileName = `${formattedDate}_${fileName}`;

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

    fs.unlinkSync(tempPath);
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
