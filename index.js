import express from "express";
import line from "@line/bot-sdk";
import fs from "fs";
import { google } from "googleapis";

const app = express();

// LINE 設定
const config = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.Client(config);

// 建立 Google Drive 客戶端（自動偵測 OAuth / Service Account）
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

    if (!serviceAccount.client_email) {
      throw new Error("Service Account JSON missing 'client_email' field");
    }

    const auth = new google.auth.GoogleAuth({
      credentials: serviceAccount,
      scopes: ["https://www.googleapis.com/auth/drive.file"],
    });
    const authClient = await auth.getClient();
    return google.drive({ version: "v3", auth: authClient });
  }
}

// 初始化 Google Drive
let drive;
createDriveClient()
  .then((client) => {
    drive = client;
    console.log("✅ Google Drive client initialized successfully");
  })
  .catch((err) => {
    console.error("❌ Google Drive initialization failed:", err);
  });

// Health check
app.get("/", (req, res) => res.status(200).send("OK"));

// LINE webhook
app.post("/webhook", line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    res.sendStatus(500);
  }
});

// 處理收到的訊息
async function handleEvent(event) {
  if (event.type !== "message") return;

  const msg = event.message;
  const user = event.source.userId;
  const messageId = msg.id;
  const folderId = process.env.GDRIVE_FOLDER_ID || null;

  // 只處理可下載的媒體類型
  if (!["image", "video", "audio", "file"].includes(msg.type)) {
    return client.replyMessage(event.replyToken, {
      type: "text",
      text: "請傳圖片、影片、音訊或檔案（PDF、ZIP 等），我會自動存到雲端。",
    });
  }

  // 產生暫存檔案
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

  // 下載 LINE 檔案
  const stream = await client.getMessageContent(messageId);
  await new Promise((resolve, reject) => {
    const writable = fs.createWriteStream(tempPath);
    stream.pipe(writable);
    writable.on("finish", resolve);
    writable.on("error", reject);
  });

  // 上傳到 Google Drive
  try {
    const fileMetadata = {
      name: fileName,
      parents: folderId ? [folderId] : [],
    };
    const media = { body: fs.createReadStream(tempPath) };
    const response = await drive.files.create({
      resource: fileMetadata,
      media: media,
      fields: "id, name, mimeType, webViewLink",
    });

    console.log(`📂 Uploaded: ${response.data.name}`);
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: `✅ 已成功上傳：${response.data.name}\n📎 連結：${response.data.webViewLink}`,
    });
  } catch (err) {
    console.error("❌ Drive upload failed:", err);
    await client.replyMessage(event.replyToken, {
      type: "text",
      text: "上傳失敗 😢，請檢查伺服器或 Drive 權限設定。",
    });
  }
}

app.listen(3000, () => console.log("🚀 LINE Bot running on port 3000"));
