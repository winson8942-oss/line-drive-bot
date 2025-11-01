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

// === 管理員 ID（你自己） ===
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || "Uxxxxxxxxxxxxxxxxxxxx"; // 改成你的 userId

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

// === 白名單 (由 Environment 初始化，可動態更新) ===
let allowedUsers = process.env.ALLOWED_USERS
  ? process.env.ALLOWED_USERS.split(",").map((id) => id.trim())
  : [];
let allowedGroups = process.env.ALLOWED_GROUPS
  ? process.env.ALLOWED_GROUPS.split(",").map((id) => id.trim())
  : [];

console.log("👥 Allowed Users:", allowedUsers);
console.log("👥 Allowed Groups:", allowedGroups);

// === 防止群組重複回覆記錄 ===
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

// === 主處理函式 ===
async function handleEvent(event) {
 console.log("🪪 event.source:", event.source);
  if (event.type !== "message") return;
  const msg = event.message;
  const sourceType = event.source.type;
  const userId = event.source.userId;
  const groupId = event.source.groupId;
  const replyToken = event.replyToken;

  // === 管理指令（僅限管理員） ===
  if (msg.type === "text" && userId === ADMIN_USER_ID) {
    const text = msg.text.trim();
    if (text === "/info") {
      const info = `👥 目前白名單\n\nUsers:\n${allowedUsers.join("\n") || "(無)"}\n\nGroups:\n${allowedGroups.join("\n") || "(無)"}`;
      await client.replyMessage(replyToken, { type: "text", text: info });
      return;
    }
    if (text.startsWith("/adduser")) {
      const id = text.split(" ")[1];
      if (id && !allowedUsers.includes(id)) {
        allowedUsers.push(id);
        await client.replyMessage(replyToken, { type: "text", text: `✅ 已加入使用者: ${id}` });
      } else {
        await client.replyMessage(replyToken, { type: "text", text: "⚠️ 無效或已存在的 UserID" });
      }
      return;
    }
    if (text.startsWith("/addgroup")) {
      const id = text.split(" ")[1];
      if (id && !allowedGroups.includes(id)) {
        allowedGroups.push(id);
        await client.replyMessage(replyToken, { type: "text", text: `✅ 已加入群組: ${id}` });
      } else {
        await client.replyMessage(replyToken, { type: "text", text: "⚠️ 無效或已存在的 GroupID" });
      }
      return;
    }
    if (text.startsWith("/deluser")) {
      const id = text.split(" ")[1];
      allowedUsers = allowedUsers.filter((u) => u !== id);
      await client.replyMessage(replyToken, { type: "text", text: `🗑 已移除使用者: ${id}` });
      return;
    }
    if (text.startsWith("/delgroup")) {
      const id = text.split(" ")[1];
      allowedGroups = allowedGroups.filter((g) => g !== id);
      await client.replyMessage(replyToken, { type: "text", text: `🗑 已移除群組: ${id}` });
      return;
    }
  }

  // === 白名單驗證 ===
  if (
    (sourceType === "user" && !allowedUsers.includes(userId)) ||
    (sourceType === "group" && !allowedGroups.includes(groupId))
  ) {
    console.log("🚫 未授權使用者或群組，拒絕服務。");
    await client.replyMessage(replyToken, {
      type: "text",
      text: "❌ 你沒有使用此 Bot 的權限。",
    });
    return;
  }

  // === 僅處理媒體 / 檔案 ===
  if (!["image", "video", "audio", "file"].includes(msg.type)) return;

  await client.replyMessage(replyToken, { type: "text", text: "⏳正在存檔中..." });

  // === 下載檔案 ===
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

  // === 分類資料夾 ===
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
      resource: { name, mimeType: "application/vnd.google-apps.folder", parents: parentId ? [parentId] : [] },
      fields: "id",
    });
    return folder.data.id;
  };

  const baseFolderId = process.env.GDRIVE_FOLDER_ID || null;
  const lineBotFolderId = await getOrCreateFolder("LINE-bot", baseFolderId);
  const chatFolderId = await getOrCreateFolder(folderName, lineBotFolderId);
  const monthFolderId = await getOrCreateFolder(monthFolderName, chatFolderId);

  // === 上傳到 Google Drive ===
  try {
    const media = { body: fs.createReadStream(tempPath) };
    await drive.files.create({
      resource: { name: newFileName, parents: [monthFolderId] },
      media,
      fields: "id",
    });
    fs.unlinkSync(tempPath); // 清理暫存檔
    console.log(`📂 Uploaded & deleted temp: ${newFileName}`);

    const key = groupId || userId;
    const nowTime = Date.now();
    if (!recentReplies.has(key) || nowTime - recentReplies.get(key) > 60000) {
      recentReplies.set(key, nowTime);
      const replyTarget = userId || groupId;
      await client.pushMessage(replyTarget, { type: "text", text: "✅已自動存檔" });
    }
  } catch (err) {
    console.error("❌ Upload failed:", err);
    await client.pushMessage(userId || groupId, { type: "text", text: "上傳失敗，請稍後再試。" });
  }
}

app.listen(3000, () => console.log("🚀 LINE Bot running on port 3000"));
