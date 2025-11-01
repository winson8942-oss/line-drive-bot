import express from 'express';
import line from '@line/bot-sdk';
import fs from 'fs';
import { google } from 'googleapis';

const app = express();

// LINE config
const config = {
  channelAccessToken: process.env.LINE_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET
};
const client = new line.Client(config);

// Google Drive auth from env var (no file needed)
const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '{}');
const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/drive.file']
});
const drive = google.drive({ version: 'v3', auth });

// Basic health check (useful for Render)
app.get('/', (_req, res) => res.status(200).send('OK'));

// Webhook endpoint
app.post('/webhook', line.middleware(config), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.sendStatus(200);
  } catch (err) {
    console.error('Webhook error:', err);
    res.sendStatus(500);
  }
});

async function handleEvent(event) {
  if (event.type !== 'message') return;

  const message = event.message;

  // We only handle image/video/audio/file
  if (!['image', 'video', 'audio', 'file'].includes(message.type)) {
    return client.replyMessage(event.replyToken, {
      type: 'text',
      text: '請傳「圖片 / 影片 / 音訊 / 檔案 (PDF 等)」來儲存到雲端。'
    });
  }

  const messageId = message.id;
  const fileName = message.type === 'file'
    ? (message.fileName || `${messageId}.dat`)
    : `${messageId}.${getFileExtension(message.type)}`;

  const tempPath = `/tmp/${fileName}`;

  // Download binary content from LINE
  const stream = await client.getMessageContent(messageId);
  await new Promise((resolve, reject) => {
    const writer = fs.createWriteStream(tempPath);
    stream.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  // Upload to Google Drive
  const fileMetadata = {
    name: fileName,
    parents: [process.env.GDRIVE_FOLDER_ID]
  };
  const mimeType = getMimeType(fileName);
  const media = { mimeType, body: fs.createReadStream(tempPath) };
  await drive.files.create({ resource: fileMetadata, media, fields: 'id' });

  // Reply to user
  await client.replyMessage(event.replyToken, {
    type: 'text',
    text: `✅ 已成功儲存：${fileName}`
  });
}

// Helpers
function getFileExtension(type) {
  switch (type) {
    case 'image': return 'jpg';   // LINE images are jpeg by default
    case 'video': return 'mp4';
    case 'audio': return 'm4a';
    default: return 'dat';
  }
}

function getMimeType(filename) {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.m4a')) return 'audio/m4a';
  if (lower.endsWith('.mp3')) return 'audio/mpeg';
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.pdf')) return 'application/pdf';
  if (lower.endsWith('.docx')) return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (lower.endsWith('.xlsx')) return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (lower.endsWith('.pptx')) return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (lower.endsWith('.zip')) return 'application/zip';
  return 'application/octet-stream';
}

app.listen(3000, () => console.log('✅ LINE Bot running on port 3000'));
