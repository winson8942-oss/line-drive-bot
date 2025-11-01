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

app.get("/", (req, res) => res.status(200).send("OK"));

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
  if (event.type !== "message") return;
  const msg = event.message;

  if (!["image", "video", "audio", "file"].includes(msg.type)) return;

  // 回覆「正在存檔中...」
  await client.replyMessage(event.replyToken, {
    type: "text",
    text: "⏳正在存檔中...",
  });

  // === 下載 LINE 檔案 ===
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

  // === 來源資料 ===
  const sourceType = event.source.type;
  let folderName = "未知聊天室";
  try {
    if (sourceType === "group") {
      const summary = await client.getGroupSummary(event.source.groupId);
      folderName = summary.groupName || `Group-${event.source.groupId.slice(-4)}`;
    } else if (sourceType === "room") {
      folderName = `Room-${event.source.roomId.slice(-4)}`;
    } else if (sourceType === "user") {
      const profile = await client.getProfile(event.source.userId);
      folderName = `User-${profile.displayName}`;
    }
  } catch {
    console.warn("⚠️ 無法取得聊天室名稱，使用預設名稱。");
  }

  // === 檔案命名與日期 ===
  const now = new Date();
  const formattedDate = now.toISOString().replace("T", "_").replace(/:/g, "-").split(".")[0];
  const monthFolderName = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const newFileName = `${formattedDate}_${fileName}`;

  // === Google Drive 資料夾結構 ===
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
  const lineBotFolderId = await getOrCreateFolder("LINE-bot", baseFolderId);
  const chatFolderId = await getOrCreateFolder(folderName, lineBotFolderId);
  const monthFolderId = await getOrCreateFolder(monthFolderName, chatFolderId);

  // === 上傳檔案到 Drive ===
  try {
    const media = { body: fs.createReadStream(tempPath) };
    await drive.files.create({
      resource: { name: newFileName, parents: [monthFolderId] },
      media,
      fields: "id, name, webViewLink",
    });
    console.log(`📂 Uploaded: ${newFileName}`);

    // === 刪除暫存檔 ===
    try {
      fs.unlinkSync(tempPath);
      console.log(`🧹 Deleted temp file: ${tempPath}`);
    } catch (e) {
      console.warn("⚠️ 無法刪除暫存檔:", e.message);
    }

    // === 防止群組重複回覆 ===
    const key =
      event.source.groupId || event.source.roomId || event.source.userId || "unknown";
    const nowTime = Date.now();

    if (!recentReplies.has(key) || nowTime - recentReplies.get(key) > 60000) {
      recentReplies.set(key, nowTime);
      const replyTarget =
        event.source.userId || event.source.groupId || event.source.roomId;
      await client.pushMessage(replyTarget, {
        type: "text",
        text: "✅已自動存檔",
      });
    } else {
      console.log("💬 已在1分鐘內回覆過，略過重複訊息。");
    }
  } catch (err) {
    console.error("❌ Upload failed:", err);
    const replyTarget =
      event.source.userId || event.source.groupId || event.source.roomId;
    await client.pushMessage(replyTarget, {
      type: "text",
      text: "上傳失敗，請稍後再試。",
    });
  }
}

app.listen(3000, () => console.log("🚀 LINE Bot running on port 3000"));
