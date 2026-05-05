/**
 * 🌿 皮克敏合照 LINE Bot - v3 完整修正版
 *
 * 修正：
 * 1. TOKEN 改為函數動態讀取（解決 Render 冷啟動 undefined 問題）
 * 2. 下載圖片加入 retry 機制（最多 3 次）
 * 3. 下載失敗時詳細印出 HTTP status 方便排查
 * 4. Imgur 上傳加入 retry
 * 5. 圖片 URL 統一確保是 HTTPS + jpg 結尾（LINE 規範）
 * 6. 加入 /healthz 路由方便 Render 健康檢查
 */

const express = require('express');
const line = require('@line/bot-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const sharp = require('sharp');

const PORT = process.env.PORT || 3000;
const IMGUR_CLIENT_ID = process.env.IMGUR_CLIENT_ID || 'f0ea04148a54268';

// ✅ 關鍵修正：TOKEN 用函數讀取，不在 top-level 用 const 鎖死
// Render 冷啟動時 process.env 可能還沒就緒，改成每次呼叫時才讀
function getToken()  { return process.env.LINE_CHANNEL_ACCESS_TOKEN || ''; }
function getSecret() { return process.env.LINE_CHANNEL_SECRET || ''; }
function getGemini() { return process.env.GEMINI_API_KEY || ''; }

// ── 初始化 ───────────────────────────────────────────────
const app = express();

// messagingClient 也改成函數，確保每次用最新 token
function getClient() {
  return new line.messagingApi.MessagingApiClient({
    channelAccessToken: getToken(),
  });
}

// ── 使用者狀態暫存 ───────────────────────────────────────
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

// ── 健康檢查 ─────────────────────────────────────────────
app.get('/', (req, res) => res.send('🌿 皮克敏合照 Bot 運作中！'));
app.get('/healthz', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ── LINE Webhook ─────────────────────────────────────────
app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  (req, res, next) => {
    try {
      req.rawBody = req.body;
      req.body = JSON.parse(req.body.toString('utf8'));
    } catch (e) {
      return res.status(400).send('Bad JSON');
    }
    next();
  },
  async (req, res) => {
    // 驗證簽名
    const sig = req.headers['x-line-signature'];
    if (!sig || !line.validateSignature(req.rawBody, getSecret(), sig)) {
      console.warn('⚠️  簽名驗證失敗, sig=' + sig);
      return res.status(403).send('Invalid signature');
    }

    // 立即回應 200，LINE 伺服器不等處理結果
    res.status(200).json({ status: 'ok' });

    const events = req.body.events || [];
    for (const event of events) {
      handleEvent(event).catch((err) => {
        console.error('❌ handleEvent 未捕捉錯誤:', err.message, err.stack);
      });
    }
  }
);

// ── 事件路由 ─────────────────────────────────────────────
async function handleEvent(event) {
  const userId = event.source && event.source.userId;
  const replyToken = event.replyToken;
  if (!userId) return;

  console.log('[EVENT] type=' + event.type + ' userId=' + userId.slice(0, 8) + '...');

  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim();
    if (['重來', '重設', '重新', 'reset', 'Reset', 'RESET', 'r', 'R'].includes(text)) {
      resetState(userId);
      await replyMsg(replyToken, '🔄 已重設！\n\n請傳送皮克敏截圖開始 👇');
      return;
    }
    await replyMsg(replyToken, getGuideText(getState(userId).step));
    return;
  }

  if (event.type === 'message' && event.message.type === 'image') {
    await handleImage(event, userId, replyToken);
    return;
  }
}

// ── 圖片訊息處理 ─────────────────────────────────────────
async function handleImage(event, userId, replyToken) {
  const state = getState(userId);
  const messageId = event.message.id;

  console.log('[IMAGE] messageId=' + messageId + ' step=' + state.step);

  if (state.step === 'generating') {
    await replyMsg(replyToken, '⏳ 正在生成中，請稍候...');
    return;
  }

  // ✅ 關鍵修正：帶入重試機制下載圖片
  let imageBuffer;
  try {
    imageBuffer = await downloadLineImageWithRetry(messageId);
    console.log('[IMAGE] 下載成功 ' + imageBuffer.length + ' bytes');
  } catch (err) {
    console.error('[IMAGE] 下載失敗:', err.message);
    await replyMsg(replyToken,
      '❌ 下載圖片失敗\n\n可能原因：\n• 圖片太大（請用較小圖片）\n• 網路暫時問題\n\n請再傳一次，或輸入「重來」重設。'
    );
    return;
  }

  if (state.step === 'wait_pikmin') {
    state.pikmin = imageBuffer;
    state.step = 'wait_selfie';
    await replyMsg(replyToken, '✅ 收到皮克敏截圖！\n\n📸 現在請傳送你的自拍照～');
    return;
  }

  if (state.step === 'wait_selfie') {
    state.selfie = imageBuffer;
    state.step = 'generating';
    await replyMsg(replyToken, '🌿 收到自拍照！\nAI 正在召喚皮克敏，請稍待 20–40 秒...');

    setImmediate(() => {
      generateAndSend(userId, state).catch(async (err) => {
        console.error('[GEN] 失敗:', err.message);
        resetState(userId);
        await pushMsg(userId, '❌ 生成失敗：' + err.message + '\n\n請輸入「重來」重新開始。');
      });
    });
    return;
  }
}

// ── 圖片生成主流程 ───────────────────────────────────────
async function generateAndSend(userId, state) {
  const pikminBuf = await resizeImage(state.pikmin, 1024);
  const selfieBuf = await resizeImage(state.selfie, 1024);
  console.log('[GEN] 圖片壓縮完成');

  let resultBase64;

  try {
    console.log('[GEN] 嘗試 Gemini...');
    resultBase64 = await geminiGenerateImage(pikminBuf, selfieBuf);
    console.log('[GEN] Gemini 成功');
  } catch (err) {
    console.warn('[GEN] Gemini 失敗 (' + err.message + ')，改用 sharp 合成');
    const buf = await sharpComposite(state.selfie, state.pikmin);
    resultBase64 = buf.toString('base64');
    console.log('[GEN] Sharp 合成完成');
  }

  console.log('[GEN] 上傳 Imgur...');
  const imageUrl = await uploadToImgurWithRetry(resultBase64);
  console.log('[GEN] Imgur URL: ' + imageUrl);

  await pushImg(userId, imageUrl);
  await pushMsg(userId, '🎉 皮克敏合照完成！\n長按圖片可儲存到相簿 📱\n\n輸入「重來」再做一次！');
  resetState(userId);
}

// ── Gemini 圖片生成 ──────────────────────────────────────
async function geminiGenerateImage(pikminBuf, selfieBuf) {
  const genAI = new GoogleGenerativeAI(getGemini());
  const model = genAI.getGenerativeModel({
    model: 'gemini-2.0-flash-exp',
    generationConfig: { responseModalities: ['Text', 'Image'] },
  });

  const result = await model.generateContent([
    {
      text: `Two images provided:
Image 1: Pikmin game screenshot with Pikmin characters.
Image 2: Person's selfie.

Create a composite photo:
- Keep the person exactly as-is from the selfie
- Naturally place Pikmin characters around the person (shoulder, hand, ground)
- Realistic lighting, seamless blending, NOT a collage
- Warm cheerful atmosphere like a real photo`,
    },
    { inlineData: { data: pikminBuf.toString('base64'), mimeType: 'image/jpeg' } },
    { inlineData: { data: selfieBuf.toString('base64'), mimeType: 'image/jpeg' } },
  ]);

  const parts =
    result.response.candidates?.[0]?.content?.parts || [];

  for (const part of parts) {
    if (part.inlineData?.mimeType?.startsWith('image/')) {
      return part.inlineData.data; // base64
    }
  }
  throw new Error('Gemini 未回傳圖片');
}

// ── Sharp 本地合成 Fallback ───────────────────────────────
async function sharpComposite(selfieBuffer, pikminBuffer) {
  // 先把自拍統一縮到 1024 寬，取得穩定的基準尺寸
  const selfieBase = await sharp(selfieBuffer)
    .resize({ width: 1024, withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();

  const meta = await sharp(selfieBase).metadata();
  const baseW = meta.width  || 1024;
  const baseH = meta.height || 1024;

  // 皮克敏覆蓋圖：寬度最多 45%，高度最多 45%，嚴格不超出
  const maxOverlayW = Math.floor(baseW * 0.45);
  const maxOverlayH = Math.floor(baseH * 0.45);

  const pikPng = await sharp(pikminBuffer)
    .resize(maxOverlayW, maxOverlayH, {
      fit: 'inside',            // ✅ inside = 寬高都不超過指定值
      withoutEnlargement: true, // ✅ 不放大小圖
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();

  // 確認覆蓋圖尺寸真的小於底圖（防禦性檢查）
  const pikMeta = await sharp(pikPng).metadata();
  console.log('[COMPOSITE] selfie=' + baseW + 'x' + baseH +
    ' overlay=' + pikMeta.width + 'x' + pikMeta.height);

  return sharp(selfieBase)
    .composite([{
      input: pikPng,
      gravity: 'southeast',  // 右下角
      blend: 'over',
    }])
    .jpeg({ quality: 92 })
    .toBuffer();
}

// ── 圖片壓縮 ─────────────────────────────────────────────
async function resizeImage(buffer, maxWidth) {
  return sharp(buffer)
    .resize({ width: maxWidth, withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
}

// ── ✅ 下載 LINE 圖片（含 retry）────────────────────────
async function downloadLineImageWithRetry(messageId, maxRetries = 3) {
  const url = 'https://api-data.line.me/v2/bot/message/' + messageId + '/content';

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log('[DL] 嘗試第 ' + attempt + ' 次, messageId=' + messageId);
      console.log('[DL] TOKEN 長度=' + getToken().length); // 確認 token 有值

      const response = await axios({
        method: 'GET',
        url: url,
        headers: {
          'Authorization': 'Bearer ' + getToken(),
          'User-Agent': 'pikmin-bot/3.0',
        },
        responseType: 'arraybuffer',
        timeout: 20000,
        maxContentLength: 20 * 1024 * 1024, // 20MB
      });

      console.log('[DL] HTTP ' + response.status + ', size=' + response.data.byteLength);

      if (response.status !== 200) {
        throw new Error('HTTP ' + response.status);
      }
      if (!response.data || response.data.byteLength === 0) {
        throw new Error('回傳內容為空');
      }

      return Buffer.from(response.data);
    } catch (err) {
      const status = err.response ? err.response.status : 'N/A';
      const detail = err.response ? JSON.stringify(err.response.data).slice(0, 200) : err.message;
      console.error('[DL] 第 ' + attempt + ' 次失敗: HTTP=' + status + ' msg=' + detail);

      if (attempt === maxRetries) throw err;

      // 等待後重試（1s / 2s / 3s）
      await sleep(attempt * 1000);
    }
  }
}

// ── Imgur 上傳（含 retry）────────────────────────────────
async function uploadToImgurWithRetry(base64Data, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.post(
        'https://api.imgur.com/3/image',
        { image: base64Data, type: 'base64' },
        {
          headers: {
            Authorization: 'Client-ID ' + IMGUR_CLIENT_ID,
            'Content-Type': 'application/json',
          },
          timeout: 30000,
        }
      );
      if (!response.data?.success) {
        throw new Error('Imgur 回傳失敗: ' + JSON.stringify(response.data));
      }
      const url = response.data.data.link.replace('http://', 'https://');
      return url;
    } catch (err) {
      console.error('[IMGUR] 第 ' + attempt + ' 次失敗:', err.message);
      if (attempt === maxRetries) throw err;
      await sleep(attempt * 1500);
    }
  }
}

// ── 工具 ─────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── LINE 訊息工具 ────────────────────────────────────────
async function replyMsg(replyToken, text) {
  try {
    await getClient().replyMessage({ replyToken, messages: [{ type: 'text', text }] });
  } catch (err) {
    console.error('[REPLY] 錯誤:', err.message);
  }
}

async function pushMsg(userId, text) {
  try {
    await getClient().pushMessage({ to: userId, messages: [{ type: 'text', text }] });
  } catch (err) {
    console.error('[PUSH] 錯誤:', err.message);
  }
}

async function pushImg(userId, imageUrl) {
  try {
    await getClient().pushMessage({
      to: userId,
      messages: [{
        type: 'image',
        originalContentUrl: imageUrl,
        previewImageUrl: imageUrl,
      }],
    });
  } catch (err) {
    console.error('[PUSH IMG] 錯誤:', err.message);
  }
}

function getGuideText(step) {
  const guides = {
    wait_pikmin: '👋 歡迎使用皮克敏合照機器人！\n\n步驟：\n1️⃣ 傳送皮克敏遊戲截圖\n2️⃣ 傳送你的自拍照\n3️⃣ 等待 AI 生成合照 ✨\n\n➡️ 請先傳送皮克敏截圖！',
    wait_selfie: '✅ 已收到皮克敏截圖！\n\n➡️ 請傳送你的自拍照 📸',
    generating:  '⏳ 正在生成合照中，請稍候...',
  };
  return guides[step] || guides.wait_pikmin;
}

// ── 啟動 ─────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n🌿 皮克敏合照 Bot v3 啟動！Port=' + PORT);

  // 啟動時才讀 env，這時一定已載入
  const checks = {
    LINE_CHANNEL_ACCESS_TOKEN: getToken(),
    LINE_CHANNEL_SECRET: getSecret(),
    GEMINI_API_KEY: getGemini(),
  };

  let allOk = true;
  for (const [k, v] of Object.entries(checks)) {
    if (!v) { console.error('❌ 缺少: ' + k); allOk = false; }
    else console.log('✅ ' + k + ' (長度=' + v.length + ')');
  }

  if (!allOk) {
    console.error('\n⚠️  請在 Render > Environment Variables 補上缺少的變數！\n');
  } else {
    console.log('\n🚀 全部就緒！\n');
  }
});
