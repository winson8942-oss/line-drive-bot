import express from "express";
import line from "@line/bot-sdk";
import fs from "fs";
import axios from "axios";
import { google } from "googleapis";

const app = express();

// ✅ LINE Bot 設定
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

// ✅ Google Drive 設定
const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
const drive = google.drive({
  version: "v3",
  auth: new google.auth.JWT(
    credentials.client_email,
    null,
    credentials.private_key,
    ["https://www.googleapis.com/auth/drive"]
  ),
});

// ✅ 預設上傳目錄 (主資料夾)
const ROOT_FOLDER_ID = process.env.GDRIVE_FOLDER_ID;

// 自動建立子資料夾（以群組或使用者ID命名）
async function ensureSubFolder(parentId, name) {
  const res = await drive.files.list({
    q: `'${parentId}' in parents and name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    fields: "files(id, name)",
  });
  if (res.data.files.length > 0) return res.data.files[0].id;

  const folderMeta = {
    name,
    mimeType: "application/vnd.google-apps.folder",
    parents: [parentId],
  };
  const folder = await drive.files.create({
    resource: folderMeta,
    fields: "id",
  });
  return folder.data.id;
}

// 處理上傳至 Google Drive
async function uploadToDrive(buffer, fileName, mimeType, folderId) {
  const res = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [folderId],
    },
    media: {
      mimeType: mimeType,
      body: buffer,
    },
    fields: "id, webViewLink",
  });
  return res.data.webViewLink;
}

// 處理 LINE 事件
app.post("/webhook", line.middleware(config), async (req, res) => {
  const events = req.body.events;
  await Promise.all(events.map(handleEvent));
  res.status(200).end();
});

async function handleEvent(event) {
  if (event.type !== "message" || !event.message.contentProvider) return;

  const { message, source } = event;

  // 決定子資料夾名稱
  let folderName = "unknown";
  if (source.type === "user") folderName = `user_${source.userId}`;
  if (source.type === "group") folderName = `group_${source.groupId}`;
  if (source.type === "room") folderName = `room_${source.roomId}`;

  // 確保子資料夾存在
  const uploadFolderId = await ensureSubFolder(ROOT_FOLDER_ID, folderName);

  // 下載內容
  const url = `https://api-data.line.me/v2/bot/message/${message.id}/content`;
  const response = await axios.get(url, {
    responseType: "stream",
    headers: { Authorization: `Bearer ${config.channelAccessToken}` },
  });

  // 判斷檔案名稱與類型
  const mimeType = message.contentProvider.type || "application/octet-stream";
  const fileName =
    (message.fileName || `${Date.now()}`) +
    (mimeType.includes("/") ? `.${mimeType.split("/")[1]}` : "");

  // 上傳到對應群組子資料夾
  const link = await uploadToDrive(response.data, fileName, mimeType, uploadFolderId);
  console.log(`✅ Uploaded ${fileName} to ${link}`);
}

// ✅ 啟動伺服器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 LINE Bot running on port ${PORT}`));
