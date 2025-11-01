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

// === 管理者 ===
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || "";

// === Google API 初始化 ===
async function createGoogleClients() {
  const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: [
      "https://www.googleapis.com/auth/drive",
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
createGoogleClients()
  .then((c) => {
    drive = c.drive;
    sheets = c.sheets;
    console.log("✅ Google APIs ready");
    initWhitelistSheet();
  })
  .catch((err) => console.error("❌ Google API init failed:", err));

// === 自動建立白名單 Sheet ===
async function initWhitelistSheet() {
  try {
    if (process.env.WHITELIST_SHEET_ID) {
      console.log("📄 已存在白名單 Sheet");
      await loadWhitelistFromSheet();
      return;
    }

    console.log("🆕 未設定 WHITELIST_SHEET_ID，自動建立中...");
    const file = await drive.files.create({
      resource: {
        name: "LINE-Bot-Whitelist",
        mimeType: "application/vnd.google-apps.spreadsheet",
      },
      fields: "id",
    });

    const sheetId = file.data.id;
    console.log("✅ 已建立新白名單 Sheet:", sheetId);

    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: "Sheet1!A1:C1",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [["Type", "ID", "備註"]],
      },
    });

    if (ADMIN_USER_ID) {
      await sheets.spreadsheets.values.append({
        spreadsheetId: sheetId,
        range: "Sheet1!A:C",
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [["user", ADMIN_USER_ID, "管理者"]],
        },
      });
      console.log("👤 已自動加入管理者至白名單");
    }

    process.env.WHITELIST_SHEET_ID = sheetId;
    await loadWhitelistFromSheet();
  } catch (err) {
    console.error("❌ 建立白名單 Sheet 失敗:", err);
  }
}

// === 白名單 ===
let ALLOWED_USERS = [];
let ALLOWED_GROUPS = [];

// === 讀取 Google Sheet 白名單 ===
async function loadWhitelistFromSheet() {
  try {
    const sheetId = process.env.WHITELIST_SHEET_ID;
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: "Sheet1!A2:B",
    });
    const rows = res.data.values || [];
    const users = [];
    const groups = [];

    rows.forEach(([type, id]) => {
      if (type === "user") users.push(id.trim());
      if (type === "group") groups.push(id.trim());
    });

    ALLOWED_USERS = users;
    ALLOWED_GROUPS = groups;
    console.log("📄 白名單同步完成");
    console.log("👤 Users:", ALLOWED_USERS);
    console.log("👥 Groups:", ALLOWED_GROUPS);
  } catch (err) {
    console.error("❌ 讀取白名單失敗:", err);
  }
}
setInterval(loadWhitelistFromSheet, 5 * 60 * 1000);

// === 寫入白名單 ===
async function addToWhitelist(type, id, name) {
  try {
    const sheetId = process.env.WHITELIST_SHEET_ID;
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: "Sheet1!A:C",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[type, id, name || ""]],
      },
    });
    console.log(`✅ 新增白名單 (${type}): ${id}`);
  } catch (err) {
    console.error("❌ 寫入白名單失敗:", err);
  }
}

// === 防止群組重複回覆 ===
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

  // === 通關密語驗證 ===
  if (msg?.type === "text") {
    const text = msg.text.trim();

    // 個人通關
    if (sourceType === "user" && !ALLOWED_USERS.includes(userId)) {
      if (text === ACCESS_KEYWORD) {
        const profile = await client.getProfile(userId);
        await addToWhitelist("user", userId, profile.displayName);
        ALLOWED_USERS.push(userId);
        await client.replyMessage(replyToken, {
          type: "text",
          text: "✅ 通關成功！已啟用自動備份。",
        });
        return;
      } else return;
    }

    // 群組通關
    if (sourceType === "group" && !ALLOWED_GROUPS.includes(groupId)) {
      if (text === ACCESS_KEYWORD) {
        const summary = await client.getGroupSummary(groupId);
        await addToWhitelist("group", groupId, summary.groupName);
        ALLOWED_GROUPS.push(groupId);
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
    (sourceType === "user" && !ALLOWED_USERS.includes(userId)) ||
    (sourceType === "group" && !ALLOWED_GROUPS.includes(groupId))
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

  // === 分群資料夾 ===
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

  const baseFolder = process.env.GDRIVE_FOLDER_ID;
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

app.listen(3000, () => console.log("🚀 LINE Bot running on port 3000"));
