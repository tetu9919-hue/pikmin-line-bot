/**
 * 🌿 皮克敏合照 LINE Bot
 * 使用 Google Gemini 2.0 Flash (免費，無需身份驗證)
 * 使用 LINE Messaging API
 * 
 * 流程：
 * 1. 使用者傳送皮克敏截圖 → Bot 記住
 * 2. 使用者傳送自拍照 → Bot 記住
 * 3. Bot 自動呼叫 Gemini 生成合照描述 → 回傳合成圖
 */

const express = require('express');
const line = require('@line/bot-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const sharp = require('sharp');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ── 設定 ────────────────────────────────────────────────
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PORT = process.env.PORT || 3000;

// ── 初始化 ───────────────────────────────────────────────
const app = express();
const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.channelAccessToken,
});
const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);

// ── 暫存使用者狀態（記憶體，重啟清空）──────────────────
// userState[userId] = { pikmin: Buffer|null, selfie: Buffer|null, step: 'wait_pikmin'|'wait_selfie'|'generating' }
const userState = {};

function getState(userId) {
  if (!userState[userId]) {
    userState[userId] = { pikmin: null, selfie: null, step: 'wait_pikmin' };
  }
  return userState[userId];
}

function resetState(userId) {
  userState[userId] = { pikmin: null, selfie: null, step: 'wait_pikmin' };
}

// ── LINE Webhook ─────────────────────────────────────────
app.post('/webhook', line.middleware(config), async (req, res) => {
  res.status(200).send('OK'); // 先回應 LINE，避免 timeout
  const events = req.body.events;
  for (const event of events) {
    try {
      await handleEvent(event);
    } catch (err) {
      console.error('Event error:', err.message);
    }
  }
});

app.get('/', (req, res) => res.send('🌿 皮克敏合照 Bot 運作中！'));

// ── 事件處理 ─────────────────────────────────────────────
async function handleEvent(event) {
  const userId = event.source.userId;
  const replyToken = event.replyToken;

  // 文字訊息
  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim();
    if (text === '重來' || text === '重設' || text === 'reset' || text === 'Reset') {
      resetState(userId);
      await reply(replyToken, makeText('🔄 已重設！請重新傳送皮克敏截圖。'));
      return;
    }
    // 說明訊息
    const state = getState(userId);
    await reply(replyToken, makeText(getHelpText(state.step)));
    return;
  }

  // 圖片訊息
  if (event.type === 'message' && event.message.type === 'image') {
    await handleImage(event, userId, replyToken);
    return;
  }
}

// ── 圖片處理核心邏輯 ─────────────────────────────────────
async function handleImage(event, userId, replyToken) {
  const state = getState(userId);

  // 下載圖片
  let imageBuffer;
  try {
    imageBuffer = await downloadLineImage(event.message.id);
  } catch (err) {
    await reply(replyToken, makeText('❌ 下載圖片失敗，請再試一次。'));
    return;
  }

  // ── 步驟一：收到皮克敏截圖 ──
  if (state.step === 'wait_pikmin') {
    state.pikmin = imageBuffer;
    state.step = 'wait_selfie';
    await reply(replyToken, [
      makeText('✅ 收到皮克敏截圖！\n\n📸 現在請傳送你的自拍照～'),
    ]);
    return;
  }

  // ── 步驟二：收到自拍照 ──
  if (state.step === 'wait_selfie') {
    state.selfie = imageBuffer;
    state.step = 'generating';
    await reply(replyToken, makeText('🌿 收到自拍照！\nAI 正在召喚皮克敏，請稍待 15–30 秒...'));

    // 異步生成，不阻塞 reply
    generateAndSend(userId, state).catch(async (err) => {
      console.error('Generate error:', err.message);
      resetState(userId);
      await push(userId, makeText(`❌ 生成失敗：${err.message}\n\n請輸入「重來」重新開始。`));
    });
    return;
  }

  // 正在生成中
  if (state.step === 'generating') {
    await reply(replyToken, makeText('⏳ 正在生成中，請稍候...'));
    return;
  }
}

// ── 核心：Gemini 生成合照 ────────────────────────────────
async function generateAndSend(userId, state) {
  try {
    // 壓縮圖片（Gemini 有大小限制）
    const pikminJpeg = await sharp(state.pikmin)
      .resize({ width: 1024, withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    const selfieJpeg = await sharp(state.selfie)
      .resize({ width: 1024, withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    // 使用 Gemini 2.0 Flash 的圖片生成功能
    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash-exp',
      generationConfig: {
        responseModalities: ['Text', 'Image'],
      },
    });

    const prompt = `You are given two images:
- Image 1: A Pikmin video game screenshot containing Pikmin characters
- Image 2: A person's selfie photo

Your task: Create a fun, realistic composite photo where the Pikmin characters from Image 1 are naturally placed around the person in Image 2.

Requirements:
- Keep the person exactly as they look in the selfie
- Extract the Pikmin characters and place them naturally: some on the shoulder, one on the hand, others on the ground
- Make it look like a real smartphone photo
- Natural lighting and realistic blending
- No collage feeling — make it seamless
- Warm, cheerful atmosphere

Please generate the composite image.`;

    const result = await model.generateContent([
      { text: prompt },
      {
        inlineData: {
          data: pikminJpeg.toString('base64'),
          mimeType: 'image/jpeg',
        },
      },
      {
        inlineData: {
          data: selfieJpeg.toString('base64'),
          mimeType: 'image/jpeg',
        },
      },
    ]);

    // 從 response 取出圖片
    const response = result.response;
    let imageBase64 = null;

    for (const part of response.candidates[0].content.parts) {
      if (part.inlineData && part.inlineData.mimeType.startsWith('image/')) {
        imageBase64 = part.inlineData.data;
        break;
      }
    }

    if (!imageBase64) {
      // Gemini 沒有直接生成圖片，改用文字描述 + 提示
      throw new Error('Gemini 這次沒有回傳圖片，請重試');
    }

    // 上傳圖片到 Imgur（免費公開圖床）作為臨時 URL
    const imageUrl = await uploadToImgur(imageBase64);

    // 回傳給使用者
    await push(userId, [
      {
        type: 'image',
        originalContentUrl: imageUrl,
        previewImageUrl: imageUrl,
      },
      makeText('🎉 皮克敏合照完成！\n長按圖片即可儲存～\n\n輸入「重來」可以再做一次！'),
    ]);

    resetState(userId);
  } catch (err) {
    throw err;
  }
}

// ── 備用方案：Gemini Vision 分析 + 說明 ──────────────────
// 若 Gemini 圖片生成不可用（模型限制），改用此方案
async function generateWithDescription(userId, state) {
  const pikminJpeg = await sharp(state.pikmin)
    .resize({ width: 800, withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();

  const selfieJpeg = await sharp(state.selfie)
    .resize({ width: 800, withoutEnlargement: true })
    .jpeg({ quality: 80 })
    .toBuffer();

  // 使用 canvas 合成圖片（本地端處理）
  const composited = await compositeImages(state.selfie, state.pikmin);
  const imageUrl = await uploadToImgur(composited.toString('base64'));

  await push(userId, [
    {
      type: 'image',
      originalContentUrl: imageUrl,
      previewImageUrl: imageUrl,
    },
    makeText('🎉 皮克敏合照完成！\n長按圖片即可儲存～\n\n輸入「重來」可以再做一次！'),
  ]);

  resetState(userId);
}

// ── 本地圖片合成（sharp）─────────────────────────────────
async function compositeImages(selfieBuffer, pikminBuffer) {
  // 取得自拍尺寸
  const selfieInfo = await sharp(selfieBuffer).metadata();
  const w = selfieInfo.width;
  const h = selfieInfo.height;

  // 將皮克敏截圖縮小到 40% 寬，放在右下角
  const pikminSize = Math.round(w * 0.45);
  const pikminResized = await sharp(pikminBuffer)
    .resize(pikminSize, pikminSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();

  // 合成
  const result = await sharp(selfieBuffer)
    .composite([
      {
        input: pikminResized,
        gravity: 'southeast',
        blend: 'over',
      },
    ])
    .jpeg({ quality: 90 })
    .toBuffer();

  return result;
}

// ── 上傳到 Imgur ─────────────────────────────────────────
async function uploadToImgur(base64Data) {
  // Imgur 匿名上傳（免費，無需帳號）
  const IMGUR_CLIENT_ID = process.env.IMGUR_CLIENT_ID || 'f0ea04148a54268'; // 公共測試 ID
  
  const response = await axios.post(
    'https://api.imgur.com/3/image',
    { image: base64Data, type: 'base64' },
    {
      headers: {
        Authorization: `Client-ID ${IMGUR_CLIENT_ID}`,
        'Content-Type': 'application/json',
      },
      timeout: 30000,
    }
  );

  if (!response.data.success) {
    throw new Error('Imgur 上傳失敗');
  }

  return response.data.data.link;
}

// ── 下載 LINE 圖片 ───────────────────────────────────────
async function downloadLineImage(messageId) {
  const stream = await client.getMessageContent(messageId);
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

// ── LINE 訊息工具 ────────────────────────────────────────
async function reply(replyToken, messages) {
  const msgs = Array.isArray(messages) ? messages : [messages];
  await client.replyMessage({ replyToken, messages: msgs });
}

async function push(userId, messages) {
  const msgs = Array.isArray(messages) ? messages : [messages];
  await client.pushMessage({ to: userId, messages: msgs });
}

function makeText(text) {
  return { type: 'text', text };
}

function getHelpText(step) {
  if (step === 'wait_pikmin') {
    return '👋 歡迎使用皮克敏合照機器人！\n\n📋 步驟：\n1️⃣ 傳送皮克敏遊戲截圖\n2️⃣ 傳送你的自拍照\n3️⃣ 等待 AI 生成合照 ✨\n\n現在請傳送皮克敏截圖！';
  }
  if (step === 'wait_selfie') {
    return '✅ 已收到皮克敏截圖！\n\n📸 請傳送你的自拍照';
  }
  return '⏳ 正在生成合照中，請稍候...';
}

// ── 啟動 ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
🌿 皮克敏合照 LINE Bot 已啟動！
📡 Port: ${PORT}
🔗 Webhook URL: https://你的網域/webhook
  `);

  // 檢查環境變數
  const missing = [];
  if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) missing.push('LINE_CHANNEL_ACCESS_TOKEN');
  if (!process.env.LINE_CHANNEL_SECRET) missing.push('LINE_CHANNEL_SECRET');
  if (!process.env.GEMINI_API_KEY) missing.push('GEMINI_API_KEY');
  if (missing.length > 0) {
    console.warn('⚠️  缺少環境變數:', missing.join(', '));
    console.warn('   請參考 .env.example 設定');
  } else {
    console.log('✅ 所有環境變數已設定！');
  }
});
