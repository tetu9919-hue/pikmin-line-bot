/**
 * 🌿 皮克敏合照 LINE Bot - v7
 *
 * 針對 Image1 vs Image2 對比分析的完整修正：
 *
 * 問題根因：
 *   - 舊版 sharp 把「整張截圖（含遊戲背景框）」切成三塊直接貼上
 *   - 結果是三個帶背景的小方框貼在角落，完全不像合照
 *
 * v7 解法：
 *   1. Gemini prompt 完全重寫 → 精確描述「去背、融入、互動感、比例」
 *      對標 Image2：皮克敏站在人旁邊、搭手、有花朵、大小自然
 *   2. sharp fallback 改寫 → 用亮度差異去背（移除遊戲背景）再貼上
 *      至少不會出現「帶背景方框」的問題
 *   3. 生成完整流程不變（所有 v3~v6 的下載/上傳/retry 全保留）
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
  return new line.messagingApi.MessagingApiClient({ channelAccessToken: getToken() });
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
app.get('/', (req, res) => res.send('🌿 皮克敏合照 Bot v7 運作中！'));
app.get('/healthz', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ── Webhook ───────────────────────────────────────────────
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res, next) => {
  try { req.rawBody = req.body; req.body = JSON.parse(req.body.toString('utf8')); }
  catch (e) { return res.status(400).send('Bad JSON'); }
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
    await replyMsg(replyToken,
      '✅ 收到皮克敏截圖！\n\n📸 現在請傳送你的照片～\n（自拍、人像、合照皆可）');
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
  // 給 Gemini 用較高解析度（提升融合品質）
  const pikBuf  = await resizeImage(state.pikmin, 1280);
  const selfBuf = await resizeImage(state.selfie, 1280);
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

// ═══════════════════════════════════════════════════════════
// ── Gemini 生成（v7 精準 prompt，對標 Image2）────────────
// ═══════════════════════════════════════════════════════════
async function geminiGenerateImage(pikBuf, selfBuf) {
  const genAI = new GoogleGenerativeAI(getGemini());
  const MODELS = [
    'gemini-2.0-flash-preview-image-generation',
    'gemini-2.0-flash-exp-image-generation',
  ];

  // ▼▼▼ 針對 Image2 效果精準設計的 prompt ▼▼▼
  const prompt = `You will receive TWO images. Your job is to create ONE final composite photo.

=== IMAGE 1 === Pikmin characters source (game screenshot)
=== IMAGE 2 === Real photo with people (THE MAIN PHOTO — keep everything intact)

━━━ STRICT RULES ━━━

【PEOPLE in IMAGE 2】
• Every person must remain EXACTLY as-is: face, clothes, body, position, expression
• Do NOT move, resize, crop, or alter any person
• The background scene from IMAGE 2 must be preserved completely

【PIKMIN CHARACTERS from IMAGE 1】
• Identify each distinct Pikmin character in IMAGE 1 (by color: red, blue, yellow, etc.)
• Use ONLY the exact Pikmin types visible in IMAGE 1 — do NOT invent new ones
• REMOVE all game backgrounds, UI elements, sky, ground textures from IMAGE 1
• Extract each Pikmin as a standalone character with TRANSPARENT background

【HOW TO PLACE PIKMIN — copy this style】
Think of the result like a real AR photo where Pikmin physically exist in the scene:
• Place 1 Pikmin jumping or climbing UP along someone's raised arm or hand (like riding the arm)
• Place 1–2 Pikmin standing on the ground beside/between the people, at ankle-to-knee height
• Place 1 Pikmin peeking from behind someone's shoulder or bag
• Optional: 1 small Pikmin sitting on top of someone's head or hat
• Pikmin should appear at DIFFERENT depths (some closer = larger, some farther = smaller)
• Pikmin near the camera foreground should be 15–20% of frame height
• Pikmin in mid-ground should be 10–13% of frame height

【REALISM & BLENDING】
• Pikmin must cast soft ground shadows matching the scene's light direction
• Match color temperature: if photo is warm/cool, tint Pikmin accordingly
• Pikmin edges must be soft and anti-aliased — zero hard cutout edges
• Result must look like a real smartphone AR photo, NOT a collage
• Preserve the full aspect ratio and resolution of IMAGE 2`;

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
        // IMAGE 1 先傳皮克敏截圖
        { inlineData: { data: pikBuf.toString('base64'),  mimeType: 'image/jpeg' } },
        // IMAGE 2 後傳人物照片
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

// ═══════════════════════════════════════════════════════════
// ── Sharp 合成 Fallback（v7：亮度去背 + 自然融合）────────
// ═══════════════════════════════════════════════════════════
async function sharpComposite(selfieBuffer, pikminBuffer) {
  // ① 人物底圖標準化
  const selfieBase = await sharp(selfieBuffer)
    .resize({ width: 1080, withoutEnlargement: true })
    .jpeg({ quality: 93 })
    .toBuffer();

  const { width: W, height: H } = await sharp(selfieBase).metadata();
  console.log('[COMPOSITE] 底圖: ' + W + 'x' + H);

  // ② 分析皮克敏截圖的背景顏色（取四個角落平均色 → 作為去背基準）
  const pikRaw = await sharp(pikminBuffer)
    .resize({ width: 600, withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { data: rawData, info: rawInfo } = pikRaw;
  const pikW = rawInfo.width;
  const pikH = rawInfo.height;
  const channels = rawInfo.channels; // 4 = RGBA

  // 取四個角落 10x10 像素的平均色 → 推斷背景色
  function getCornerAvg(cx, cy, r) {
    let rSum = 0, gSum = 0, bSum = 0, count = 0;
    for (let dy = 0; dy < r; dy++) {
      for (let dx = 0; dx < r; dx++) {
        const x = Math.min(cx + dx, pikW - 1);
        const y = Math.min(cy + dy, pikH - 1);
        const idx = (y * pikW + x) * channels;
        rSum += rawData[idx]; gSum += rawData[idx+1]; bSum += rawData[idx+2];
        count++;
      }
    }
    return { r: rSum/count, g: gSum/count, b: bSum/count };
  }

  const corners = [
    getCornerAvg(0, 0, 10),
    getCornerAvg(pikW - 10, 0, 10),
    getCornerAvg(0, pikH - 10, 10),
    getCornerAvg(pikW - 10, pikH - 10, 10),
  ];
  const bgR = corners.reduce((s,c)=>s+c.r,0)/4;
  const bgG = corners.reduce((s,c)=>s+c.g,0)/4;
  const bgB = corners.reduce((s,c)=>s+c.b,0)/4;
  console.log('[COMPOSITE] 推斷背景色: rgb(' +
    Math.round(bgR) + ',' + Math.round(bgG) + ',' + Math.round(bgB) + ')');

  // ③ 對每個像素：計算與背景色的距離，距離小 → 透明，距離大 → 不透明
  const threshold = 80; // 顏色差距閾值（可調整）
  const edgeSoftness = 40; // 邊緣軟化範圍

  const newData = Buffer.alloc(rawData.length);
  for (let i = 0; i < rawData.length; i += channels) {
    const pr = rawData[i], pg = rawData[i+1], pb = rawData[i+2];
    const dist = Math.sqrt(
      Math.pow(pr - bgR, 2) + Math.pow(pg - bgG, 2) + Math.pow(pb - bgB, 2)
    );
    newData[i]   = pr;
    newData[i+1] = pg;
    newData[i+2] = pb;
    // 距離 < threshold → 完全透明；距離 > threshold+edgeSoftness → 完全不透明；中間漸變
    const alpha = Math.max(0, Math.min(255,
      Math.round((dist - threshold) / edgeSoftness * 255)
    ));
    newData[i+3] = alpha;
  }

  // ④ 重建去背後的皮克敏 PNG
  const pikRemoved = await sharp(newData, {
    raw: { width: pikW, height: pikH, channels: 4 }
  }).png().toBuffer();

  // ⑤ 把去背結果裁切成 3 份，各自縮放後放到自然位置
  const sliceW = Math.floor(pikW / 3);

  async function makeChar(sliceLeft, targetSize) {
    const w = Math.min(sliceW, pikW - sliceLeft);
    return sharp(pikRemoved)
      .extract({ left: sliceLeft, top: 0, width: w, height: pikH })
      .resize(targetSize, targetSize, {
        fit: 'inside',
        withoutEnlargement: true,
        background: { r:0, g:0, b:0, alpha:0 }
      })
      .png()
      .toBuffer();
  }

  const sizeL = Math.floor(W * 0.19);  // 前景較大
  const sizeM = Math.floor(W * 0.13);  // 肩膀小
  const sizeR = Math.floor(W * 0.16);  // 中景

  const [charL, charM, charR] = await Promise.all([
    makeChar(0,         sizeL),
    makeChar(sliceW,    sizeM),
    makeChar(sliceW*2,  sizeR),
  ]);

  const [mL, mM, mR] = await Promise.all([
    sharp(charL).metadata(),
    sharp(charM).metadata(),
    sharp(charR).metadata(),
  ]);

  // ⑥ 計算擺放位置：以人物照片尺寸為基準，邊界安全
  function safe(val, maxVal) { return Math.max(0, Math.min(maxVal, Math.round(val))); }
  function rand(range) { return Math.floor((Math.random() - 0.5) * range); }

  const layers = [
    // 左前景：靠近相機的人腳邊，偏前偏低
    {
      input: charL, blend: 'over',
      left: safe(W * 0.05 + rand(50), W - mL.width),
      top:  safe(H * 0.72 + rand(40), H - mL.height),
    },
    // 右中景：另一人腳邊
    {
      input: charR, blend: 'over',
      left: safe(W * 0.65 + rand(50), W - mR.width),
      top:  safe(H * 0.70 + rand(40), H - mR.height),
    },
    // 肩膀：左側人物肩膀高度
    {
      input: charM, blend: 'over',
      left: safe(W * 0.20 + rand(40), W - mM.width),
      top:  safe(H * 0.22 + rand(30), H - mM.height),
    },
  ];

  layers.forEach((l, i) =>
    console.log('[COMPOSITE] 角色' + (i+1) + ': ' + l.left + 'x' + l.top)
  );

  const result = await sharp(selfieBase)
    .composite(layers)
    .jpeg({ quality: 93 })
    .toBuffer();

  console.log('[COMPOSITE] 完成 ' + result.length + ' bytes');
  return result;
}

// ── 圖片壓縮 ──────────────────────────────────────────────
async function resizeImage(buffer, maxWidth) {
  return sharp(buffer)
    .resize({ width: maxWidth, withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toBuffer();
}

// ── 下載 LINE 圖片（含 retry）────────────────────────────
async function downloadLineImageWithRetry(messageId, maxRetries = 3) {
  const url = 'https://api-data.line.me/v2/bot/message/' + messageId + '/content';
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log('[DL] #' + attempt + ' tokenLen=' + getToken().length);
      const res = await axios({
        method: 'GET', url,
        headers: { Authorization: 'Bearer ' + getToken(), 'User-Agent': 'pikmin-bot/7.0' },
        responseType: 'arraybuffer',
        timeout: 20000,
        maxContentLength: 20 * 1024 * 1024,
      });
      if (!res.data || res.data.byteLength === 0) throw new Error('空回應');
      console.log('[DL] 成功 ' + res.data.byteLength + ' bytes');
      return Buffer.from(res.data);
    } catch (err) {
      const s = err.response ? err.response.status : 'N/A';
      console.error('[DL] #' + attempt + ' 失敗 HTTP=' + s + ' ' + err.message);
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
      if (!res.data?.success) throw new Error('Imgur: ' + JSON.stringify(res.data));
      return res.data.data.link.replace('http://', 'https://');
    } catch (err) {
      console.error('[IMGUR] #' + attempt + ' 失敗:', err.message);
      if (attempt === maxRetries) throw err;
      await sleep(attempt * 1500);
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── LINE 工具 ─────────────────────────────────────────────
async function replyMsg(replyToken, text) {
  try { await getClient().replyMessage({ replyToken, messages: [{ type: 'text', text }] }); }
  catch (e) { console.error('[REPLY]', e.message); }
}
async function pushMsg(userId, text) {
  try { await getClient().pushMessage({ to: userId, messages: [{ type: 'text', text }] }); }
  catch (e) { console.error('[PUSH]', e.message); }
}
async function pushImg(userId, imageUrl) {
  try {
    await getClient().pushMessage({ to: userId, messages: [{
      type: 'image', originalContentUrl: imageUrl, previewImageUrl: imageUrl,
    }]});
  } catch (e) { console.error('[PUSH IMG]', e.message); }
}

function getGuideText(step) {
  return ({
    wait_pikmin:
      '👋 歡迎使用皮克敏合照機器人！\n\n' +
      '📋 步驟：\n' +
      '1️⃣ 傳送皮克敏遊戲截圖\n' +
      '   截圖中有哪些皮克敏，合照就放哪些 🌿\n' +
      '2️⃣ 傳送你的照片\n' +
      '   自拍、人像、多人合照皆可 📸\n' +
      '3️⃣ AI 自動生成合照 ✨\n\n' +
      '➡️ 請先傳送皮克敏截圖！',
    wait_selfie:
      '✅ 收到皮克敏截圖！\n\n' +
      '➡️ 請傳送你的照片 📸\n' +
      '（自拍、人像、合照皆可）',
    generating: '⏳ 正在生成合照中，請稍候...',
  })[step] || '➡️ 請傳送皮克敏截圖！';
}

// ── 啟動 ──────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n🌿 皮克敏合照 Bot v7 啟動！Port=' + PORT);
  const checks = {
    LINE_CHANNEL_ACCESS_TOKEN: getToken(),
    LINE_CHANNEL_SECRET:       getSecret(),
    GEMINI_API_KEY:            getGemini(),
  };
  let allOk = true;
  for (const [k, v] of Object.entries(checks)) {
    if (!v) { console.error('❌ 缺少: ' + k); allOk = false; }
    else     console.log('✅ ' + k + ' (長度=' + v.length + ')');
  }
  console.log(allOk ? '\n🚀 全部就緒！\n' : '\n⚠️ 請補上缺少的環境變數！\n');
});
