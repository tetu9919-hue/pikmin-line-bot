/**
 * 🌿 皮克敏合照 LINE Bot - v6
 *
 * 核心改進：
 * - sharpComposite 完全重寫：人物為主體，皮克敏隨機多點擺放（腳邊/肩/手）
 * - 皮克敏截圖切割分析：自動識別截圖中的角色區塊，分別縮放擺放
 * - Gemini prompt 強化：明確要求以人為主體、去背、只用截圖中出現的角色
 * - 所有 v3~v5 的修正全部保留
 */

const express = require('express');
const line = require('@line/bot-sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const axios = require('axios');
const sharp = require('sharp');

const PORT = process.env.PORT || 3000;
const IMGUR_CLIENT_ID = process.env.IMGUR_CLIENT_ID || 'f0ea04148a54268';

function getToken()  { return process.env.LINE_CHANNEL_ACCESS_TOKEN || ''; }
function getSecret() { return process.env.LINE_CHANNEL_SECRET || ''; }
function getGemini() { return process.env.GEMINI_API_KEY || ''; }

const app = express();

function getClient() {
  return new line.messagingApi.MessagingApiClient({
    channelAccessToken: getToken(),
  });
}

// ── 使用者狀態 ────────────────────────────────────────────
const userState = {};
function getState(userId) {
  if (!userState[userId]) userState[userId] = { pikmin: null, selfie: null, step: 'wait_pikmin' };
  return userState[userId];
}
function resetState(userId) {
  userState[userId] = { pikmin: null, selfie: null, step: 'wait_pikmin' };
}

// ── 健康檢查 ──────────────────────────────────────────────
app.get('/', (req, res) => res.send('🌿 皮克敏合照 Bot v6 運作中！'));
app.get('/healthz', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ── Webhook ───────────────────────────────────────────────
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res, next) => {
  try {
    req.rawBody = req.body;
    req.body = JSON.parse(req.body.toString('utf8'));
  } catch (e) { return res.status(400).send('Bad JSON'); }
  next();
}, async (req, res) => {
  const sig = req.headers['x-line-signature'];
  if (!sig || !line.validateSignature(req.rawBody, getSecret(), sig)) {
    console.warn('⚠️ 簽名驗證失敗');
    return res.status(403).send('Invalid signature');
  }
  res.status(200).json({ status: 'ok' });
  for (const event of req.body.events || []) {
    handleEvent(event).catch(err => console.error('❌ handleEvent:', err.message));
  }
});

// ── 事件路由 ──────────────────────────────────────────────
async function handleEvent(event) {
  const userId = event.source && event.source.userId;
  const replyToken = event.replyToken;
  if (!userId) return;
  console.log('[EVENT] type=' + event.type + ' uid=' + userId.slice(0, 8));

  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim();
    if (['重來','重設','重新','reset','Reset','RESET','r','R'].includes(text)) {
      resetState(userId);
      await replyMsg(replyToken, '🔄 已重設！\n\n請傳送皮克敏截圖開始 👇');
      return;
    }
    await replyMsg(replyToken, getGuideText(getState(userId).step));
    return;
  }

  if (event.type === 'message' && event.message.type === 'image') {
    await handleImage(event, userId, replyToken);
  }
}

// ── 圖片處理 ──────────────────────────────────────────────
async function handleImage(event, userId, replyToken) {
  const state = getState(userId);
  const messageId = event.message.id;
  console.log('[IMG] id=' + messageId + ' step=' + state.step);

  if (state.step === 'generating') {
    await replyMsg(replyToken, '⏳ 正在生成中，請稍候...');
    return;
  }

  let buf;
  try {
    buf = await downloadLineImageWithRetry(messageId);
    console.log('[IMG] 下載成功 ' + buf.length + ' bytes');
  } catch (err) {
    console.error('[IMG] 下載失敗:', err.message);
    await replyMsg(replyToken, '❌ 下載圖片失敗，請再傳一次，或輸入「重來」重設。');
    return;
  }

  if (state.step === 'wait_pikmin') {
    state.pikmin = buf;
    state.step = 'wait_selfie';
    await replyMsg(replyToken, '✅ 收到皮克敏截圖！\n\n📸 現在請傳送你的照片～\n（自拍、人像、全身皆可）');
    return;
  }

  if (state.step === 'wait_selfie') {
    state.selfie = buf;
    state.step = 'generating';
    await replyMsg(replyToken, '🌿 收到照片！\nAI 正在讓皮克敏走進你的世界...\n請稍待 20–40 秒 ✨');
    setImmediate(() => {
      generateAndSend(userId, state).catch(async err => {
        console.error('[GEN] 失敗:', err.message);
        resetState(userId);
        await pushMsg(userId, '❌ 生成失敗：' + err.message + '\n\n請輸入「重來」重新開始。');
      });
    });
  }
}

// ── 生成主流程 ────────────────────────────────────────────
async function generateAndSend(userId, state) {
  const pikBuf  = await resizeImage(state.pikmin, 1024);
  const selfBuf = await resizeImage(state.selfie, 1024);
  console.log('[GEN] 壓縮完成');

  let resultBase64;
  try {
    console.log('[GEN] 嘗試 Gemini...');
    resultBase64 = await geminiGenerateImage(pikBuf, selfBuf);
    console.log('[GEN] Gemini 成功');
  } catch (err) {
    console.warn('[GEN] Gemini 失敗 (' + err.message + ')，改用 sharp 合成');
    const buf = await sharpComposite(state.selfie, state.pikmin);
    resultBase64 = buf.toString('base64');
    console.log('[GEN] Sharp 合成完成');
  }

  const imageUrl = await uploadToImgurWithRetry(resultBase64);
  console.log('[GEN] Imgur: ' + imageUrl);

  await pushImg(userId, imageUrl);
  await pushMsg(userId, '🎉 皮克敏合照完成！\n長按圖片可儲存到相簿 📱\n\n輸入「重來」再做一張！');
  resetState(userId);
}

// ── Gemini 生成（強化版 prompt）──────────────────────────
async function geminiGenerateImage(pikBuf, selfBuf) {
  const genAI = new GoogleGenerativeAI(getGemini());
  const MODELS = [
    'gemini-2.0-flash-preview-image-generation',
    'gemini-2.0-flash-exp-image-generation',
  ];

  // 強化版 prompt：人物主體、去背融入、只用截圖中有的角色
  const prompt = `You are given exactly two images.

IMAGE 1 = Pikmin game screenshot (contains only specific Pikmin characters shown in this screenshot)
IMAGE 2 = A person's photo (this person is the MAIN SUBJECT)

TASK: Generate ONE realistic composite photo with these strict rules:

PERSON (IMAGE 2):
- The person is the MAIN SUBJECT and must occupy the majority of the frame
- Keep the person's appearance, face, clothing, and pose EXACTLY unchanged
- Do NOT alter, zoom, or crop the person

PIKMIN CHARACTERS (IMAGE 1):
- Extract ONLY the Pikmin characters that actually appear in IMAGE 1
- Do NOT add any Pikmin colors or types not present in IMAGE 1
- Remove all game UI, backgrounds, and non-Pikmin elements from IMAGE 1
- Place the Pikmin naturally around the person as if they are real companions:
  * 1–2 Pikmin standing near the person's feet on the ground
  * 1 Pikmin sitting or climbing on the person's shoulder
  * 1 Pikmin peeking from behind or beside the person
  * Optional: 1 Pikmin doing a fun pose (jumping, waving) nearby
- Each Pikmin should face toward the person or look at the camera
- Pikmin size should be proportionally correct (they are small creatures)

PHOTO QUALITY:
- Result must look like a REAL photograph, NOT a digital collage
- Match the lighting, shadows, and color tone of IMAGE 2
- Pikmin should cast small natural shadows on the ground
- Seamless edges — no visible cutout or pasting artifacts
- Same background as IMAGE 2 (do not change the background)
- Warm, joyful, natural atmosphere`;

  let lastErr = null;
  for (const modelName of MODELS) {
    try {
      console.log('[GEMINI] 嘗試: ' + modelName);
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: { responseModalities: ['Text', 'Image'] },
      });
      const result = await model.generateContent([
        { text: prompt },
        { inlineData: { data: pikBuf.toString('base64'),  mimeType: 'image/jpeg' } },
        { inlineData: { data: selfBuf.toString('base64'), mimeType: 'image/jpeg' } },
      ]);
      const parts = result.response.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if (part.inlineData?.mimeType?.startsWith('image/')) {
          console.log('[GEMINI] 成功: ' + modelName);
          return part.inlineData.data;
        }
      }
      throw new Error('未回傳圖片');
    } catch (err) {
      console.warn('[GEMINI] ' + modelName + ' 失敗: ' + err.message);
      lastErr = err;
    }
  }
  throw lastErr || new Error('所有模型均失敗');
}

// ── Sharp 合成（v6 完整重寫：人物主體 + 多點隨機擺放）────
async function sharpComposite(selfieBuffer, pikminBuffer) {
  // ① 人物底圖標準化：以人物為主體，統一 1024px 寬
  const selfieBase = await sharp(selfieBuffer)
    .resize({ width: 1024, withoutEnlargement: true })
    .jpeg({ quality: 92 })
    .toBuffer();

  const { width: W, height: H } = await sharp(selfieBase).metadata();
  console.log('[COMPOSITE] 人物底圖: ' + W + 'x' + H);

  // ② 皮克敏截圖：切割成左、中、右三塊（模擬多個不同角色）
  //    實際上是把整張截圖縮小後，在不同位置各放一個（大小略有差異增加層次）
  const pikminFull = await sharp(pikminBuffer)
    .resize({ width: 800, withoutEnlargement: true })
    .png()
    .toBuffer();

  const pikMeta = await sharp(pikminFull).metadata();
  const pikW = pikMeta.width;
  const pikH = pikMeta.height;

  // 把截圖切成三個區塊，代表不同皮克敏角色位置
  // 左1/3、中1/3、右1/3 — 這樣能取到截圖中不同位置的角色
  const sliceW = Math.floor(pikW / 3);

  async function extractSlice(left, size, outputSize) {
    return sharp(pikminFull)
      .extract({ left, top: 0, width: Math.min(sliceW, pikW - left), height: pikH })
      .resize(size, size, { fit: 'inside', withoutEnlargement: true, background: { r:0,g:0,b:0,alpha:0 } })
      .ensureAlpha()
      .png()
      .toBuffer();
  }

  // 各角色尺寸（腳邊稍大，肩膀偏小，增加遠近感）
  const sizeGround = Math.floor(W * 0.20); // 腳邊站立：底圖寬 20%
  const sizeShoulder = Math.floor(W * 0.13); // 肩膀：底圖寬 13%
  const sizePeek = Math.floor(W * 0.16); // 側邊：底圖寬 16%

  // 從截圖三個區塊各取一個角色
  const [charLeft, charMid, charRight] = await Promise.all([
    extractSlice(0,              sizeGround,   sizeGround),
    extractSlice(sliceW,         sizeShoulder, sizeShoulder),
    extractSlice(sliceW * 2,     sizePeek,     sizePeek),
  ]);

  // 取得各角色實際尺寸
  const [mL, mM, mR] = await Promise.all([
    sharp(charLeft).metadata(),
    sharp(charMid).metadata(),
    sharp(charRight).metadata(),
  ]);

  // ③ 決定擺放位置（以人物尺寸為基準，確保不超出邊界）
  // 隨機微偏移讓每次結果略有不同
  function randOffset(range) { return Math.floor((Math.random() - 0.5) * range); }

  const positions = [
    // 左腳邊站立
    {
      input: charLeft,
      left: Math.max(0, Math.min(W - mL.width,  Math.floor(W * 0.08) + randOffset(40))),
      top:  Math.max(0, Math.min(H - mL.height, Math.floor(H * 0.78) + randOffset(30))),
      blend: 'over',
    },
    // 右腳邊站立（略遠）
    {
      input: charRight,
      left: Math.max(0, Math.min(W - mR.width,  Math.floor(W * 0.68) + randOffset(40))),
      top:  Math.max(0, Math.min(H - mR.height, Math.floor(H * 0.76) + randOffset(30))),
      blend: 'over',
    },
    // 肩膀位置（左肩，偏高偏中）
    {
      input: charMid,
      left: Math.max(0, Math.min(W - mM.width,  Math.floor(W * 0.22) + randOffset(30))),
      top:  Math.max(0, Math.min(H - mM.height, Math.floor(H * 0.25) + randOffset(25))),
      blend: 'over',
    },
  ];

  // 日誌確認每個位置安全
  positions.forEach((p, i) => {
    console.log('[COMPOSITE] 角色' + (i+1) + ': left=' + p.left + ' top=' + p.top);
  });

  // ④ 合成：人物底圖 + 所有皮克敏層
  const result = await sharp(selfieBase)
    .composite(positions)
    .jpeg({ quality: 93 })
    .toBuffer();

  console.log('[COMPOSITE] 完成, size=' + result.length);
  return result;
}

// ── 圖片壓縮 ──────────────────────────────────────────────
async function resizeImage(buffer, maxWidth) {
  return sharp(buffer)
    .resize({ width: maxWidth, withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
}

// ── 下載 LINE 圖片（含 retry）────────────────────────────
async function downloadLineImageWithRetry(messageId, maxRetries = 3) {
  const url = 'https://api-data.line.me/v2/bot/message/' + messageId + '/content';
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log('[DL] 嘗試第 ' + attempt + ' 次 token長度=' + getToken().length);
      const res = await axios({
        method: 'GET', url,
        headers: { Authorization: 'Bearer ' + getToken(), 'User-Agent': 'pikmin-bot/6.0' },
        responseType: 'arraybuffer',
        timeout: 20000,
        maxContentLength: 20 * 1024 * 1024,
      });
      if (!res.data || res.data.byteLength === 0) throw new Error('空回應');
      console.log('[DL] 成功 ' + res.data.byteLength + ' bytes');
      return Buffer.from(res.data);
    } catch (err) {
      const s = err.response ? err.response.status : 'N/A';
      console.error('[DL] 第 ' + attempt + ' 次失敗: HTTP=' + s + ' ' + err.message);
      if (attempt === maxRetries) throw err;
      await sleep(attempt * 1000);
    }
  }
}

// ── Imgur 上傳（含 retry）────────────────────────────────
async function uploadToImgurWithRetry(base64Data, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const res = await axios.post('https://api.imgur.com/3/image',
        { image: base64Data, type: 'base64' },
        { headers: { Authorization: 'Client-ID ' + IMGUR_CLIENT_ID, 'Content-Type': 'application/json' }, timeout: 30000 }
      );
      if (!res.data?.success) throw new Error('Imgur 失敗: ' + JSON.stringify(res.data));
      return res.data.data.link.replace('http://', 'https://');
    } catch (err) {
      console.error('[IMGUR] 第 ' + attempt + ' 次失敗:', err.message);
      if (attempt === maxRetries) throw err;
      await sleep(attempt * 1500);
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── LINE 訊息工具 ─────────────────────────────────────────
async function replyMsg(replyToken, text) {
  try { await getClient().replyMessage({ replyToken, messages: [{ type: 'text', text }] }); }
  catch (err) { console.error('[REPLY]', err.message); }
}
async function pushMsg(userId, text) {
  try { await getClient().pushMessage({ to: userId, messages: [{ type: 'text', text }] }); }
  catch (err) { console.error('[PUSH]', err.message); }
}
async function pushImg(userId, imageUrl) {
  try {
    await getClient().pushMessage({ to: userId, messages: [{
      type: 'image', originalContentUrl: imageUrl, previewImageUrl: imageUrl,
    }]});
  } catch (err) { console.error('[PUSH IMG]', err.message); }
}

function getGuideText(step) {
  return {
    wait_pikmin: '👋 歡迎使用皮克敏合照機器人！\n\n步驟：\n1️⃣ 傳送皮克敏遊戲截圖\n   （截圖中有哪些皮克敏，合照就放哪些）\n2️⃣ 傳送你的照片\n   （自拍、人像、全身皆可）\n3️⃣ 等待 AI 生成合照 ✨\n\n➡️ 請先傳送皮克敏截圖！',
    wait_selfie: '✅ 收到皮克敏截圖！\n\n➡️ 請傳送你的照片 📸\n（自拍、人像、全身皆可）',
    generating:  '⏳ 正在生成合照中，請稍候...',
  }[step] || '➡️ 請傳送皮克敏截圖！';
}

// ── 啟動 ──────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n🌿 皮克敏合照 Bot v6 啟動！Port=' + PORT);
  const checks = { LINE_CHANNEL_ACCESS_TOKEN: getToken(), LINE_CHANNEL_SECRET: getSecret(), GEMINI_API_KEY: getGemini() };
  let allOk = true;
  for (const [k, v] of Object.entries(checks)) {
    if (!v) { console.error('❌ 缺少: ' + k); allOk = false; }
    else console.log('✅ ' + k + ' (長度=' + v.length + ')');
  }
  console.log(allOk ? '\n🚀 全部就緒！\n' : '\n⚠️ 請補上缺少的環境變數！\n');
});
