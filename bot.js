/**
 * 🌿 皮克敏合照 LINE Bot - v9
 *
 * 兩階段 AI 生成架構：
 *
 * 【第一階段】角色特徵解構 (Character Analysis)
 *   使用者上傳皮克敏截圖
 *   → Gemini 深度分析角色：種類、顏色、體型、材質、比例
 *   → 將特徵描述暫存到 state.characterProfile
 *   → 回覆使用者確認（讓使用者知道 AI 看懂了幾隻角色）
 *
 * 【第二階段】原生融合生成 (Native AR Generation)
 *   使用者上傳人物照片
 *   → 把第一階段的特徵描述 + 人物照片 + 皮克敏截圖全部傳給 Gemini
 *   → Prompt 要求「原生生成」而非去背貼上
 *   → 回傳完成的 AR 合照
 *
 * 核心突破：
 *   跳過「去背」步驟，改用 AI 直接在場景中「畫出」角色
 *   → 邊緣完美、光影一致、無背景殘留
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

// ══════════════════════════════════════════════════════════════
// 使用者狀態
// step:
//   'wait_pikmin'   → 等待皮克敏截圖
//   'analyzing'     → Gemini 分析角色特徵中
//   'wait_selfie'   → 等待人物照片（已有特徵描述）
//   'generating'    → Gemini 生成合照中
// ══════════════════════════════════════════════════════════════
const userState = {};

function getState(userId) {
  if (!userState[userId]) {
    userState[userId] = {
      pikmin: null,          // 皮克敏截圖 Buffer
      selfie: null,          // 人物照片 Buffer
      characterProfile: '',  // 第一階段 AI 分析結果
      step: 'wait_pikmin',
    };
  }
  return userState[userId];
}

function resetState(userId) {
  userState[userId] = {
    pikmin: null, selfie: null, characterProfile: '', step: 'wait_pikmin',
  };
}

// ── 健康檢查 ──────────────────────────────────────────────────
app.get('/', (req, res) => res.send('🌿 皮克敏合照 Bot v9 運作中！'));
app.get('/healthz', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ── Webhook ───────────────────────────────────────────────────
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

// ── 事件路由 ──────────────────────────────────────────────────
async function handleEvent(event) {
  const userId = event.source && event.source.userId;
  const replyToken = event.replyToken;
  if (!userId) return;
  console.log('[EVENT] type=' + event.type + ' uid=' + userId.slice(0, 8));

  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text.trim();
    const resetWords = ['重來','重設','重新','reset','Reset','RESET','r','R'];
    if (resetWords.includes(text)) {
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

// ── 圖片訊息處理 ──────────────────────────────────────────────
async function handleImage(event, userId, replyToken) {
  const state = getState(userId);
  const messageId = event.message.id;
  console.log('[IMG] id=' + messageId + ' step=' + state.step);

  // 生成中或分析中：忽略
  if (state.step === 'generating' || state.step === 'analyzing') {
    await replyMsg(replyToken, '⏳ 處理中，請稍候...');
    return;
  }

  // 下載圖片
  let buf;
  try {
    buf = await downloadLineImageWithRetry(messageId);
    console.log('[IMG] 下載成功 ' + buf.length + ' bytes');
  } catch (err) {
    console.error('[IMG] 下載失敗:', err.message);
    await replyMsg(replyToken, '❌ 下載圖片失敗，請再傳一次，或輸入「重來」重設。');
    return;
  }

  // ════════════════════════════════════════════════
  // 第一階段：收到皮克敏截圖 → 開始角色特徵分析
  // ════════════════════════════════════════════════
  if (state.step === 'wait_pikmin') {
    state.pikmin = buf;
    state.step = 'analyzing';

    await replyMsg(replyToken,
      '🔍 收到截圖！\nAI 正在解析角色特徵...\n請稍待幾秒 ✨');

    setImmediate(() => {
      analyzeCharacters(userId, state).catch(async err => {
        console.error('[ANALYZE] 失敗:', err.message);
        // 分析失敗也繼續，用空的 profile（fallback）
        state.characterProfile = '';
        state.step = 'wait_selfie';
        await pushMsg(userId,
          '⚠️ 角色分析遇到問題，將使用標準模式繼續。\n\n📸 請傳送你的照片～');
      });
    });
    return;
  }

  // ════════════════════════════════════════════════
  // 第二階段：收到人物照片 → 開始合成
  // ════════════════════════════════════════════════
  if (state.step === 'wait_selfie') {
    state.selfie = buf;
    state.step = 'generating';

    await replyMsg(replyToken,
      '🌿 收到照片！\nAI 正在讓角色走進你的世界...\n請稍待 30–60 秒 ✨');

    setImmediate(() => {
      generateAndSend(userId, state).catch(async err => {
        console.error('[GEN] 失敗:', err.message);
        resetState(userId);
        await pushMsg(userId,
          '❌ 生成失敗：' + err.message + '\n\n請輸入「重來」重新開始。');
      });
    });
  }
}

// ══════════════════════════════════════════════════════════════
// 【第一階段】角色特徵解構
// ══════════════════════════════════════════════════════════════
async function analyzeCharacters(userId, state) {
  console.log('[ANALYZE] 開始角色特徵分析...');

  const genAI = new GoogleGenerativeAI(getGemini());
  // 分析用純文字模型即可，不需要圖片輸出
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  const analyzePrompt = `請對這張圖片中的虛擬角色進行深度特徵解構，作為後續 AR 合照生成任務的依據。

請以結構化方式提供以下資訊（使用英文回答，以便後續 AI 生成使用）：

1. CHARACTER LIST: List all unique character types with their exact colors.

2. ANATOMICAL FEATURES: For each character, describe in detail:
   - Body shape and proportions
   - Eye shape, size, and color
   - Head decorations (leaves, flowers, antennae, etc.) — describe size, color, texture
   - Ear shape or limb features
   - Mouth or facial expression characteristics

3. MATERIAL & TEXTURE: Describe the surface quality of each character:
   - Is it matte, glossy, rubbery, plant-fiber-like, or other?
   - Any special effects (glow, translucency, etc.)?
   - Describe the 3D rendering style (e.g., smooth plastic-like, organic, cartoon)

4. SCALE REFERENCE: Describe the characters' proportions relative to humans:
   - Approximate height compared to a human (e.g., ankle height, knee height, hand-sized)
   - Relative size between different characters (if multiple exist)

5. UNIQUE IDENTIFIERS: List any distinctive features that must be preserved exactly
   (e.g., the exact shade of the flower, the specific shape of the leaf, ear proportions)

Be precise and detailed — this analysis will be used to natively re-render these characters in a real photograph.`;

  const pikBuf = await resizeImage(state.pikmin, 1024);

  const result = await model.generateContent([
    { text: analyzePrompt },
    { inlineData: { data: pikBuf.toString('base64'), mimeType: 'image/jpeg' } },
  ]);

  const profile = result.response.text();
  state.characterProfile = profile;
  state.step = 'wait_selfie';

  console.log('[ANALYZE] 分析完成，特徵描述長度:', profile.length);
  console.log('[ANALYZE] 摘要:\n' + profile.slice(0, 300) + '...');

  // 解析角色數量（讓使用者知道 AI 看懂了幾隻）
  const characterCount = (profile.match(/\d+\.\s*(Red|Blue|Yellow|Green|Purple|White|Rock|Winged|Bulbmin)/gi) || []).length;
  const countText = characterCount > 0 ? characterCount + ' 種角色' : '角色特徵';

  await pushMsg(userId,
    '✅ 角色特徵解析完成！\n' +
    '🔬 AI 已辨識出 ' + countText + '\n\n' +
    '📸 現在請傳送你的照片～\n（自拍、人像、多人合照皆可）');
}

// ══════════════════════════════════════════════════════════════
// 【第二階段】原生融合生成主流程
// ══════════════════════════════════════════════════════════════
async function generateAndSend(userId, state) {
  const pikBuf  = await resizeImage(state.pikmin, 1280);
  const selfBuf = await resizeImage(state.selfie, 1280);
  console.log('[GEN] 圖片壓縮完成');
  console.log('[GEN] characterProfile 長度:', state.characterProfile.length);

  let resultBase64;
  try {
    console.log('[GEN] 嘗試 Gemini 原生生成...');
    resultBase64 = await geminiNativeGenerate(pikBuf, selfBuf, state.characterProfile);
    console.log('[GEN] Gemini 成功');
  } catch (err) {
    console.warn('[GEN] Gemini 失敗 (' + err.message + ')，改用 sharp fallback');
    const buf = await sharpComposite(state.selfie, state.pikmin);
    resultBase64 = buf.toString('base64');
    console.log('[GEN] Sharp fallback 完成');
  }

  const imageUrl = await uploadToImgurWithRetry(resultBase64);
  console.log('[GEN] Imgur: ' + imageUrl);

  await pushImg(userId, imageUrl);
  await pushMsg(userId,
    '🎉 皮克敏合照完成！\n' +
    '長按圖片可儲存到相簿 📱\n\n' +
    '輸入「重來」再做一張！');
  resetState(userId);
}

// ══════════════════════════════════════════════════════════════
// 【第二階段】Gemini 原生 AR 生成
// 接收：皮克敏截圖、人物照片、第一階段特徵描述
// ══════════════════════════════════════════════════════════════
async function geminiNativeGenerate(pikBuf, selfBuf, characterProfile) {
  const genAI = new GoogleGenerativeAI(getGemini());
  const MODELS = [
    'gemini-2.0-flash-preview-image-generation',
    'gemini-2.0-flash-exp-image-generation',
  ];

  // ── 第二階段：原生融合生成指令 ──────────────────────────
  const hasProfile = characterProfile && characterProfile.length > 50;

  const profileSection = hasProfile
    ? `\n\n═══════════════════════════════════════════\nCHARACTER ANALYSIS FROM STAGE 1 (use this as the definitive reference):\n═══════════════════════════════════════════\n${characterProfile}\n═══════════════════════════════════════════\n`
    : '\n\n[Note: Analyze the character source image directly to identify all characters.]\n';

  const prompt = `You are executing a two-stage AR image synthesis task.
${profileSection}
═══════════════════════════════════════════
STAGE 2 — NATIVE AR INTEGRATION & SYNTHESIS
═══════════════════════════════════════════

Two images are provided:
• image_0 = The REAL photograph (main subject — preserve EVERYTHING)
• image_1 = The CHARACTER SOURCE (game screenshot — for reference only)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【TASK OBJECTIVE】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Execute high-quality native image composition.
Preserve the real scene from image_0 entirely.
Using the character analysis above, DIRECTLY RE-RENDER the 3D virtual characters
natively into the photograph — do NOT copy-paste or crop from image_1.
This native generation approach ensures perfect edge blending and lighting integration.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【RULE 1】ABSOLUTE PRESERVATION OF REAL SUBJECTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Use the real photograph (image_0) as the base. Do NOT alter it.
• Every person: face, expression, body, clothing, position — 100% unchanged.
• No filters, no warping, no color grading applied to real people.
• Background: all buildings, vehicles, vegetation, lighting — fully preserved.
• CRITICAL INTERACTION POINTS — must not be moved or obscured:
  - Any raised hand, peace sign, or gesture → key placement point for characters
  - Any hand holding an object (cup, bag, phone) → character can peek from here

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【RULE 2】NATIVE CHARACTER GENERATION (no copy-paste)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Based on the character analysis, directly DRAW/RENDER each character into the scene.
• Because you are generating natively (not cutting from image_1):
  - Zero background residue from the game screenshot
  - Perfectly clean edges that blend with real-world textures
  - Characters appear as if they were photographed in the scene
• Maintain all defining features: exact colors, leaf/flower details, ear shapes, textures.
• Use ONLY the character types identified in image_1 — do not invent new ones.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【RULE 3】SPATIAL GEOMETRY & PERSPECTIVE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Place characters at DIFFERENT depths with strict perspective scaling:

PLACEMENT A — "Riding the Arm" (HIGHEST PRIORITY):
  • Place one character climbing or perching on a raised arm, peace-sign hand,
    or wrist of a person in the photo.
  • It should look like it is gripping the arm, riding or balancing on it.
  • Scale: proportionally small (like a real small creature on a human arm).

PLACEMENT B — "Near-Camera Foreground" (LARGEST):
  • Place one character in the near foreground (ground level, near the frame edge).
  • Scale: 15–20% of total frame height (close to camera = larger).
  • It should face the camera or look up at the people. Sharp focus.

PLACEMENT C — "Mid-Ground Companion":
  • Place one character standing on the ground between or beside people.
  • Scale: 10–13% of frame height. Slightly less sharp than foreground.
  • Position naturally as if it wandered into the scene.

PLACEMENT D — "Peek-a-boo" (optional):
  • Tuck a small character behind an object a person is holding (cup, bag).
  • Scale: 6–8% of frame height. Cautious, peeking expression.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【RULE 4】ENVIRONMENTAL BLENDING (CRITICAL)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LIGHTING:
  • Analyze the light source direction in image_0.
  • Apply the same directional lighting to all rendered characters.
  • Highlight and shadow sides must match the scene exactly.

AMBIENT OCCLUSION (contact shadows):
  • Every character touching a surface must have a soft contact shadow.
  • Shadow softness and direction = matches real shadows visible in image_0.
  • For characters on arms/clothing: subtle fabric contact shadow.

COLOR TEMPERATURE SYNC:
  • Match the warmth/coolness of the scene (outdoor daylight, indoor warm light, etc.).
  • Characters must not look like oversaturated 3D assets.
  • Slight color grading to match the photo's atmospheric haze or warmth.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【RULE 5】DEPTH OF FIELD MATCHING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  • Match the blur level of each character to its depth in the scene.
  • Foreground character = sharp (same as nearest person).
  • Mid-ground character = slight blur (same as mid-ground elements).
  • If background has bokeh, background characters should also be softly blurred.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【OUTPUT REQUIREMENT】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Generate ONE high-resolution, photorealistic composite image.
The result must convey: "these virtual characters were ACTUALLY PRESENT when the photo was taken."
Preserve the exact aspect ratio and resolution of image_0.
Final mood: warm, joyful, natural — like a real AR moment captured on a smartphone.`;

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
        // image_0 = 人物照片（主體底圖）
        { inlineData: { data: selfBuf.toString('base64'), mimeType: 'image/jpeg' } },
        // image_1 = 皮克敏截圖（角色素材，配合特徵描述使用）
        { inlineData: { data: pikBuf.toString('base64'),  mimeType: 'image/jpeg' } },
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

// ══════════════════════════════════════════════════════════════
// Sharp 合成 Fallback（去背 + 自然位置）
// ══════════════════════════════════════════════════════════════
async function sharpComposite(selfieBuffer, pikminBuffer) {
  const selfieBase = await sharp(selfieBuffer)
    .resize({ width: 1080, withoutEnlargement: true })
    .jpeg({ quality: 93 })
    .toBuffer();

  const { width: W, height: H } = await sharp(selfieBase).metadata();
  console.log('[FALLBACK] 底圖: ' + W + 'x' + H);

  // 顏色距離去背
  const pikRaw = await sharp(pikminBuffer)
    .resize({ width: 600, withoutEnlargement: true })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { data: rawData, info } = pikRaw;
  const { width: pikW, height: pikH, channels } = info;

  function cornerAvg(cx, cy, r) {
    let rs=0, gs=0, bs=0, n=0;
    for (let dy=0; dy<r; dy++) for (let dx=0; dx<r; dx++) {
      const x=Math.min(cx+dx,pikW-1), y=Math.min(cy+dy,pikH-1);
      const i=(y*pikW+x)*channels;
      rs+=rawData[i]; gs+=rawData[i+1]; bs+=rawData[i+2]; n++;
    }
    return { r:rs/n, g:gs/n, b:bs/n };
  }

  const corners = [
    cornerAvg(0,0,12), cornerAvg(pikW-12,0,12),
    cornerAvg(0,pikH-12,12), cornerAvg(pikW-12,pikH-12,12),
  ];
  const bgR=corners.reduce((s,c)=>s+c.r,0)/4;
  const bgG=corners.reduce((s,c)=>s+c.g,0)/4;
  const bgB=corners.reduce((s,c)=>s+c.b,0)/4;
  console.log('[FALLBACK] 背景色 rgb(' + Math.round(bgR) + ',' + Math.round(bgG) + ',' + Math.round(bgB) + ')');

  const threshold=75, edgeSoft=45;
  const newData = Buffer.alloc(rawData.length);
  for (let i=0; i<rawData.length; i+=channels) {
    const pr=rawData[i], pg=rawData[i+1], pb=rawData[i+2];
    const dist=Math.sqrt(Math.pow(pr-bgR,2)+Math.pow(pg-bgG,2)+Math.pow(pb-bgB,2));
    newData[i]=pr; newData[i+1]=pg; newData[i+2]=pb;
    newData[i+3]=Math.max(0,Math.min(255,Math.round((dist-threshold)/edgeSoft*255)));
  }

  const pikRemoved = await sharp(newData, {
    raw: { width: pikW, height: pikH, channels: 4 }
  }).png().toBuffer();

  const sliceW = Math.floor(pikW/3);
  async function makeChar(left, size) {
    return sharp(pikRemoved)
      .extract({ left, top:0, width:Math.min(sliceW,pikW-left), height:pikH })
      .resize(size, size, { fit:'inside', withoutEnlargement:true, background:{r:0,g:0,b:0,alpha:0} })
      .png().toBuffer();
  }

  const [cL,cM,cR] = await Promise.all([
    makeChar(0,           Math.floor(W*0.19)),
    makeChar(sliceW,      Math.floor(W*0.13)),
    makeChar(sliceW*2,    Math.floor(W*0.16)),
  ]);
  const [mL,mM,mR] = await Promise.all([
    sharp(cL).metadata(), sharp(cM).metadata(), sharp(cR).metadata(),
  ]);

  function s(v, max) { return Math.max(0, Math.min(max, Math.round(v))); }
  function r(range)  { return Math.floor((Math.random()-0.5)*range); }

  const layers = [
    { input:cL, blend:'over', left:s(W*0.05+r(50),W-mL.width), top:s(H*0.72+r(40),H-mL.height) },
    { input:cR, blend:'over', left:s(W*0.65+r(50),W-mR.width), top:s(H*0.70+r(40),H-mR.height) },
    { input:cM, blend:'over', left:s(W*0.20+r(40),W-mM.width), top:s(H*0.22+r(30),H-mM.height) },
  ];

  layers.forEach((l,i) => console.log('[FALLBACK] 角色' + (i+1) + ': ' + l.left + ',' + l.top));

  return sharp(selfieBase)
    .composite(layers)
    .jpeg({ quality: 93 })
    .toBuffer();
}

// ── 工具函數 ──────────────────────────────────────────────────
async function resizeImage(buffer, maxWidth) {
  return sharp(buffer)
    .resize({ width: maxWidth, withoutEnlargement: true })
    .jpeg({ quality: 88 })
    .toBuffer();
}

async function downloadLineImageWithRetry(messageId, maxRetries=3) {
  const url = 'https://api-data.line.me/v2/bot/message/' + messageId + '/content';
  for (let attempt=1; attempt<=maxRetries; attempt++) {
    try {
      console.log('[DL] #' + attempt + ' tokenLen=' + getToken().length);
      const res = await axios({
        method:'GET', url,
        headers: { Authorization:'Bearer '+getToken(), 'User-Agent':'pikmin-bot/9.0' },
        responseType:'arraybuffer', timeout:20000,
        maxContentLength: 20*1024*1024,
      });
      if (!res.data || res.data.byteLength===0) throw new Error('空回應');
      console.log('[DL] 成功 ' + res.data.byteLength + ' bytes');
      return Buffer.from(res.data);
    } catch (err) {
      const s = err.response ? err.response.status : 'N/A';
      console.error('[DL] #' + attempt + ' 失敗 HTTP=' + s + ' ' + err.message);
      if (attempt===maxRetries) throw err;
      await sleep(attempt*1000);
    }
  }
}

async function uploadToImgurWithRetry(base64Data, maxRetries=3) {
  for (let attempt=1; attempt<=maxRetries; attempt++) {
    try {
      const res = await axios.post('https://api.imgur.com/3/image',
        { image:base64Data, type:'base64' },
        { headers:{ Authorization:'Client-ID '+IMGUR_CLIENT_ID, 'Content-Type':'application/json' }, timeout:30000 }
      );
      if (!res.data?.success) throw new Error('Imgur: ' + JSON.stringify(res.data));
      return res.data.data.link.replace('http://','https://');
    } catch (err) {
      console.error('[IMGUR] #' + attempt + ' 失敗:', err.message);
      if (attempt===maxRetries) throw err;
      await sleep(attempt*1500);
    }
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── LINE 工具 ──────────────────────────────────────────────────
async function replyMsg(replyToken, text) {
  try { await getClient().replyMessage({ replyToken, messages:[{type:'text',text}] }); }
  catch (e) { console.error('[REPLY]', e.message); }
}
async function pushMsg(userId, text) {
  try { await getClient().pushMessage({ to:userId, messages:[{type:'text',text}] }); }
  catch (e) { console.error('[PUSH]', e.message); }
}
async function pushImg(userId, imageUrl) {
  try {
    await getClient().pushMessage({ to:userId, messages:[{
      type:'image', originalContentUrl:imageUrl, previewImageUrl:imageUrl,
    }]});
  } catch (e) { console.error('[PUSH IMG]', e.message); }
}

function getGuideText(step) {
  const guides = {
    wait_pikmin:
      '👋 歡迎使用皮克敏合照機器人！\n\n' +
      '【使用步驟】\n' +
      '1️⃣ 傳送皮克敏截圖\n' +
      '   AI 會先解析截圖中的角色特徵 🔍\n' +
      '2️⃣ 傳送你的照片\n' +
      '   AI 根據特徵直接在照片中生成角色 🎨\n' +
      '3️⃣ 取得高品質 AR 合照 ✨\n\n' +
      '輸入「重來」可隨時重設\n\n' +
      '➡️ 請先傳送皮克敏截圖！',
    analyzing:
      '🔍 AI 正在分析角色特徵，請稍候...',
    wait_selfie:
      '✅ 角色特徵已解析完成！\n\n' +
      '➡️ 請傳送你的照片 📸\n' +
      '（自拍、人像、多人合照皆可）',
    generating:
      '⏳ AI 正在生成合照，請稍候...',
  };
  return guides[step] || guides.wait_pikmin;
}

// ── 啟動 ──────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n🌿 皮克敏合照 Bot v9 啟動！Port=' + PORT);
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
