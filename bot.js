/**
 * 🌿 皮克敏合照 LINE Bot - v10
 *
 * 完整節點診斷 + 修正版：
 *
 * 修正節點：
 *   1. /debug 路由 → 直接從瀏覽器測試每個環境變數和 API 連線
 *   2. analyzeCharacters → 改用 axios 直接呼叫 Gemini REST API
 *      （完全繞過 SDK，消除 SDK 版本問題）
 *   3. 詳細 log 每一個失敗原因（HTTP 狀態、response body）
 *   4. 角色分析失敗時，改為「繼續生成」而不是中止
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

// ── 狀態管理 ──────────────────────────────────────────────────
const userState = {};
function getState(userId) {
  if (!userState[userId]) {
    userState[userId] = { pikmin: null, selfie: null, characterProfile: '', step: 'wait_pikmin' };
  }
  return userState[userId];
}
function resetState(userId) {
  userState[userId] = { pikmin: null, selfie: null, characterProfile: '', step: 'wait_pikmin' };
}

// ══════════════════════════════════════════════════════════════
// /debug 路由：直接從瀏覽器測試所有節點
// 開啟：https://你的Render網址/debug
// ══════════════════════════════════════════════════════════════
app.get('/debug', async (req, res) => {
  const results = {};

  // 節點1：環境變數
  const token = getToken();
  const secret = getSecret();
  const geminiKey = getGemini();

  results.env = {
    LINE_CHANNEL_ACCESS_TOKEN: token ? '✅ 已設定 (長度=' + token.length + ', 開頭=' + token.slice(0,8) + '...)' : '❌ 未設定',
    LINE_CHANNEL_SECRET:       secret ? '✅ 已設定 (長度=' + secret.length + ')' : '❌ 未設定',
    GEMINI_API_KEY:            geminiKey ? '✅ 已設定 (長度=' + geminiKey.length + ', 開頭=' + geminiKey.slice(0,8) + '...)' : '❌ 未設定',
    GEMINI_KEY_FORMAT:         geminiKey.startsWith('AIzaSy') ? '✅ 格式正確 (AIzaSy...)' : '⚠️ 格式異常 (應以 AIzaSy 開頭)',
  };

  // 節點2：Gemini API 連線測試（用純文字，不傳圖片）
  if (geminiKey) {
    try {
      const testUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + geminiKey;
      const testRes = await axios.post(testUrl, {
        contents: [{ parts: [{ text: 'Reply with exactly: OK' }] }]
      }, { timeout: 10000 });

      const reply = testRes.data?.candidates?.[0]?.content?.parts?.[0]?.text || '(空)';
      results.gemini_text = '✅ 純文字呼叫成功: ' + reply.trim().slice(0, 50);
    } catch (e) {
      const status = e.response?.status || 'N/A';
      const body = JSON.stringify(e.response?.data || e.message).slice(0, 200);
      results.gemini_text = '❌ 失敗 HTTP=' + status + ' | ' + body;
    }
  } else {
    results.gemini_text = '⏭️ 跳過（未設定 GEMINI_API_KEY）';
  }

  // 節點3：Gemini API Vision 測試（傳一張小圖）
  if (geminiKey) {
    try {
      const tiny = await sharp({ create: { width: 10, height: 10, channels: 3, background: {r:255,g:0,b:0} } }).jpeg().toBuffer();
      const testUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + geminiKey;
      const testRes = await axios.post(testUrl, {
        contents: [{
          parts: [
            { text: 'What color is this image? Reply in one word.' },
            { inline_data: { mime_type: 'image/jpeg', data: tiny.toString('base64') } },
          ]
        }]
      }, { timeout: 15000 });

      const reply = testRes.data?.candidates?.[0]?.content?.parts?.[0]?.text || '(空)';
      results.gemini_vision = '✅ Vision 呼叫成功: ' + reply.trim().slice(0, 80);
    } catch (e) {
      const status = e.response?.status || 'N/A';
      const body = JSON.stringify(e.response?.data || e.message).slice(0, 200);
      results.gemini_vision = '❌ Vision 失敗 HTTP=' + status + ' | ' + body;
    }
  } else {
    results.gemini_vision = '⏭️ 跳過';
  }

  // 節點4：LINE API 測試
  if (token) {
    try {
      const profileRes = await axios.get('https://api.line.me/v2/bot/info', {
        headers: { Authorization: 'Bearer ' + token }, timeout: 8000
      });
      results.line_api = '✅ LINE Bot 連線成功: ' + (profileRes.data?.displayName || '(無名稱)');
    } catch (e) {
      results.line_api = '❌ LINE API 失敗 HTTP=' + (e.response?.status || 'N/A') + ' | ' + JSON.stringify(e.response?.data || '').slice(0,100);
    }
  } else {
    results.line_api = '⏭️ 跳過（未設定 Token）';
  }

  // 節點5：Sharp 運作確認
  try {
    const buf = await sharp({ create:{width:10,height:10,channels:3,background:{r:0,g:255,b:0}} }).jpeg().toBuffer();
    results.sharp = '✅ sharp 正常運作 (' + buf.length + ' bytes)';
  } catch (e) {
    results.sharp = '❌ sharp 錯誤: ' + e.message;
  }

  // 輸出 HTML
  const html = `<!DOCTYPE html>
<html lang="zh-TW">
<head><meta charset="UTF-8"><title>Bot Debug</title>
<style>
body{font-family:monospace;background:#1a1a1a;color:#eee;padding:20px;max-width:900px;margin:0 auto}
h1{color:#4caf50}h2{color:#ffd54f;margin-top:24px}
.ok{color:#66ff66}.fail{color:#ff6666}.warn{color:#ffaa44}.skip{color:#888}
pre{background:#2a2a2a;padding:12px;border-radius:8px;white-space:pre-wrap;word-break:break-all}
</style></head>
<body>
<h1>🌿 皮克敏 Bot 節點診斷</h1>
<p style="color:#aaa">時間: ${new Date().toISOString()}</p>

<h2>【節點1】環境變數</h2>
<pre>${Object.entries(results.env).map(([k,v])=>`${k}: ${v}`).join('\n')}</pre>

<h2>【節點2】Gemini 純文字 API</h2>
<pre>${results.gemini_text}</pre>

<h2>【節點3】Gemini Vision API（含圖片）</h2>
<pre>${results.gemini_vision}</pre>

<h2>【節點4】LINE Bot API</h2>
<pre>${results.line_api}</pre>

<h2>【節點5】Sharp 圖片處理</h2>
<pre>${results.sharp}</pre>

<h2>診斷結論</h2>
<pre>${
    (!geminiKey) ? '❌ GEMINI_API_KEY 未設定 → 去 Render Environment 加入' :
    (!geminiKey.startsWith('AIzaSy')) ? '⚠️ GEMINI_API_KEY 格式可能有誤 → 確認是否完整複製' :
    (results.gemini_vision.startsWith('❌')) ? '❌ Gemini Vision API 失敗 → 查看節點3錯誤碼' :
    (results.gemini_text.startsWith('❌')) ? '❌ Gemini 文字 API 失敗 → 查看節點2錯誤碼' :
    '✅ 所有節點正常！如果 Bot 還是有問題，請查看 Render Logs'
}</pre>
</body></html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// ── 健康檢查 ──────────────────────────────────────────────────
app.get('/', (req, res) => res.send('🌿 皮克敏合照 Bot v10 運作中！<br><a href="/debug">🔍 節點診斷</a>'));
app.get('/healthz', (req, res) => res.json({ status: 'ok', version: 'v10', time: new Date().toISOString() }));

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
  const userId = event.source?.userId;
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

// ── 圖片處理 ──────────────────────────────────────────────────
async function handleImage(event, userId, replyToken) {
  const state = getState(userId);
  const messageId = event.message.id;
  console.log('[IMG] id=' + messageId + ' step=' + state.step);

  if (state.step === 'generating' || state.step === 'analyzing') {
    await replyMsg(replyToken, '⏳ 處理中，請稍候...');
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
    state.step = 'analyzing';
    await replyMsg(replyToken, '🔍 收到截圖！\nAI 正在解析角色特徵...\n請稍待幾秒 ✨');
    setImmediate(() => {
      analyzeCharacters(userId, state).catch(async err => {
        console.error('[ANALYZE] 外層 catch 錯誤:', err.message);
        state.characterProfile = '';
        state.step = 'wait_selfie';
        await pushMsg(userId, '⚠️ 角色分析失敗（' + err.message.slice(0, 60) + '）\n\n將使用標準模式繼續。\n📸 請傳送你的照片～');
      });
    });
    return;
  }

  if (state.step === 'wait_selfie') {
    state.selfie = buf;
    state.step = 'generating';
    await replyMsg(replyToken, '🌿 收到照片！\nAI 正在讓角色走進你的世界...\n請稍待 30–60 秒 ✨');
    setImmediate(() => {
      generateAndSend(userId, state).catch(async err => {
        console.error('[GEN] 失敗:', err.message);
        resetState(userId);
        await pushMsg(userId, '❌ 生成失敗：' + err.message + '\n\n請輸入「重來」重新開始。');
      });
    });
  }
}

// ══════════════════════════════════════════════════════════════
// 【第一階段】角色特徵解構
// 改用 axios 直接呼叫 Gemini REST API（繞過 SDK 版本問題）
// ══════════════════════════════════════════════════════════════
async function analyzeCharacters(userId, state) {
  console.log('[ANALYZE] 開始...');

  const key = getGemini();
  if (!key) throw new Error('GEMINI_API_KEY 未設定');

  const pikBuf = await resizeImage(state.pikmin, 1024);
  const pikB64 = pikBuf.toString('base64');

  const MODELS = [
    'gemini-2.0-flash',
    'gemini-2.0-flash-lite',
    'gemini-1.5-flash',
    'gemini-1.5-flash-latest',
  ];

  const prompt = `Analyze this game screenshot. List each unique character type you see with:
1. Name and color
2. Body shape and key visual features (eyes, head decoration, ears, limbs)
3. Surface material (matte/glossy/rubber/etc)
4. Approximate size compared to a human (ankle-height / palm-sized / knee-height)
5. Must-preserve features (exact colors, unique decorations)
Be specific and detailed in English. This will be used to re-render these characters in a real photo.`;

  let profile = '';
  let lastErr = null;

  for (const modelName of MODELS) {
    try {
      console.log('[ANALYZE] 嘗試模型 (REST): ' + modelName);
      const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + modelName + ':generateContent?key=' + key;

      const body = {
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: 'image/jpeg', data: pikB64 } },
          ]
        }],
        generationConfig: { maxOutputTokens: 1024, temperature: 0.2 },
      };

      const res = await axios.post(url, body, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000,
      });

      // 詳細 log API response
      console.log('[ANALYZE] HTTP ' + res.status);

      const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      if (!text || text.length < 50) {
        const reason = res.data?.candidates?.[0]?.finishReason || '未知';
        throw new Error('回傳內容空或過短 (finishReason=' + reason + ')');
      }

      profile = text.trim();
      console.log('[ANALYZE] ✅ 成功! model=' + modelName + ' len=' + profile.length);
      console.log('[ANALYZE] 前300字: ' + profile.slice(0, 300));
      break;

    } catch (err) {
      const status = err.response?.status || 'N/A';
      const detail = JSON.stringify(err.response?.data || err.message).slice(0, 150);
      console.error('[ANALYZE] ❌ ' + modelName + ' HTTP=' + status + ' | ' + detail);
      lastErr = err;
    }
  }

  if (!profile) {
    const errMsg = lastErr?.response?.data?.error?.message || lastErr?.message || '未知';
    throw new Error(errMsg);
  }

  state.characterProfile = profile;
  state.step = 'wait_selfie';

  // 解析角色名稱
  const chars = [...new Set((profile.match(/\b(Red|Blue|Yellow|Green|Purple|White|Rock|Winged|Bulbmin)\s+Pikmin\b/gi) || []).map(s => s.trim()))];
  const charText = chars.length > 0 ? '\n🎨 ' + chars.join('、') : '';

  await pushMsg(userId,
    '✅ 角色特徵解析完成！' + charText +
    '\n\n📸 請傳送你的照片～\n（自拍、人像、多人合照皆可）');
}

// ══════════════════════════════════════════════════════════════
// 【第二階段】AR 生成
// ══════════════════════════════════════════════════════════════
async function generateAndSend(userId, state) {
  const pikBuf  = await resizeImage(state.pikmin, 1280);
  const selfBuf = await resizeImage(state.selfie, 1280);
  console.log('[GEN] 圖片壓縮完成 profile長度=' + state.characterProfile.length);

  let resultBase64;
  try {
    resultBase64 = await geminiNativeGenerate(pikBuf, selfBuf, state.characterProfile);
    console.log('[GEN] Gemini 成功');
  } catch (err) {
    console.warn('[GEN] Gemini 失敗 (' + err.message + ')，改用 sharp');
    const buf = await sharpComposite(state.selfie, state.pikmin);
    resultBase64 = buf.toString('base64');
  }

  const imageUrl = await uploadToImgurWithRetry(resultBase64);
  console.log('[GEN] URL: ' + imageUrl);

  await pushImg(userId, imageUrl);
  await pushMsg(userId, '🎉 皮克敏合照完成！\n長按圖片儲存到相簿 📱\n\n輸入「重來」再做一張！');
  resetState(userId);
}

// ══════════════════════════════════════════════════════════════
// Gemini 原生 AR 生成（REST API）
// ══════════════════════════════════════════════════════════════
async function geminiNativeGenerate(pikBuf, selfBuf, characterProfile) {
  const key = getGemini();
  if (!key) throw new Error('GEMINI_API_KEY 未設定');

  const MODELS = [
    'gemini-2.0-flash-preview-image-generation',
    'gemini-2.0-flash-exp-image-generation',
  ];

  const profileSection = characterProfile.length > 50
    ? '\n\n=== CHARACTER ANALYSIS (from Stage 1) ===\n' + characterProfile + '\n=== END ===\n'
    : '';

  const prompt = `High-fidelity AR photo composition task.${profileSection}

TWO IMAGES PROVIDED:
- image_0 (FIRST image) = Real photo → THE MAIN SUBJECT, preserve everything 100%
- image_1 (SECOND image) = Game screenshot → character reference only

TASK: Natively RE-RENDER (do not copy-paste) the virtual characters from image_1 into image_0.

RULES:
1. PRESERVE image_0 completely: all people (faces/clothes/poses), background, lighting
2. GENERATE characters natively based on the analysis above — zero game background residue
3. PLACEMENT: arm/hand interaction (highest priority), near-camera foreground, mid-ground
4. SCALE: foreground=15-20% frame height, mid-ground=10-13%, vary by depth
5. LIGHTING: match image_0 light direction, add contact shadows, sync color temperature
6. DEPTH OF FIELD: blur characters to match their scene depth
7. OUTPUT: same aspect ratio as image_0, photorealistic AR feel`;

  let lastErr = null;

  for (const modelName of MODELS) {
    try {
      console.log('[GEN] 嘗試 (REST): ' + modelName);
      const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + modelName + ':generateContent?key=' + key;

      const body = {
        contents: [{
          parts: [
            { text: prompt },
            { inline_data: { mime_type: 'image/jpeg', data: selfBuf.toString('base64') } },
            { inline_data: { mime_type: 'image/jpeg', data: pikBuf.toString('base64') } },
          ]
        }],
        generationConfig: { responseModalities: ['TEXT', 'IMAGE'] },
      };

      const res = await axios.post(url, body, {
        headers: { 'Content-Type': 'application/json' },
        timeout: 90000,
        maxContentLength: 50 * 1024 * 1024,
      });

      const parts = res.data?.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if (part.inline_data?.mime_type?.startsWith('image/')) {
          console.log('[GEN] ✅ 成功: ' + modelName);
          return part.inline_data.data;
        }
        if (part.inlineData?.mimeType?.startsWith('image/')) {
          console.log('[GEN] ✅ 成功 (camelCase): ' + modelName);
          return part.inlineData.data;
        }
      }

      const textParts = parts.filter(p => p.text).map(p => p.text).join(' ');
      console.warn('[GEN] 無圖片回傳, text=' + textParts.slice(0, 100));
      throw new Error('未回傳圖片 parts=' + parts.length);

    } catch (err) {
      const status = err.response?.status || 'N/A';
      const detail = JSON.stringify(err.response?.data || err.message).slice(0, 150);
      console.warn('[GEN] ❌ ' + modelName + ' HTTP=' + status + ' | ' + detail);
      lastErr = err;
    }
  }
  throw lastErr || new Error('所有生成模型失敗');
}

// ══════════════════════════════════════════════════════════════
// Sharp Fallback
// ══════════════════════════════════════════════════════════════
async function sharpComposite(selfieBuffer, pikminBuffer) {
  const selfieBase = await sharp(selfieBuffer)
    .resize({ width: 1080, withoutEnlargement: true })
    .jpeg({ quality: 93 }).toBuffer();

  const { width: W, height: H } = await sharp(selfieBase).metadata();

  const pikRaw = await sharp(pikminBuffer)
    .resize({ width: 600, withoutEnlargement: true })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });

  const { data: rawData, info } = pikRaw;
  const { width: pikW, height: pikH, channels } = info;

  function cAvg(cx, cy, r) {
    let rs=0,gs=0,bs=0,n=0;
    for (let dy=0;dy<r;dy++) for (let dx=0;dx<r;dx++) {
      const x=Math.min(cx+dx,pikW-1), y=Math.min(cy+dy,pikH-1), i=(y*pikW+x)*channels;
      rs+=rawData[i]; gs+=rawData[i+1]; bs+=rawData[i+2]; n++;
    }
    return {r:rs/n,g:gs/n,b:bs/n};
  }
  const corners=[cAvg(0,0,12),cAvg(pikW-12,0,12),cAvg(0,pikH-12,12),cAvg(pikW-12,pikH-12,12)];
  const bgR=corners.reduce((s,c)=>s+c.r,0)/4;
  const bgG=corners.reduce((s,c)=>s+c.g,0)/4;
  const bgB=corners.reduce((s,c)=>s+c.b,0)/4;

  const newData = Buffer.alloc(rawData.length);
  for (let i=0;i<rawData.length;i+=channels) {
    const pr=rawData[i],pg=rawData[i+1],pb=rawData[i+2];
    const dist=Math.sqrt((pr-bgR)**2+(pg-bgG)**2+(pb-bgB)**2);
    newData[i]=pr; newData[i+1]=pg; newData[i+2]=pb;
    newData[i+3]=Math.max(0,Math.min(255,Math.round((dist-75)/45*255)));
  }
  const pikPng = await sharp(newData,{raw:{width:pikW,height:pikH,channels:4}}).png().toBuffer();

  const sw=Math.floor(pikW/3);
  const mk = async (left,size) => sharp(pikPng)
    .extract({left,top:0,width:Math.min(sw,pikW-left),height:pikH})
    .resize(size,size,{fit:'inside',withoutEnlargement:true,background:{r:0,g:0,b:0,alpha:0}})
    .png().toBuffer();

  const [cL,cM,cR]=await Promise.all([mk(0,Math.floor(W*.19)),mk(sw,Math.floor(W*.13)),mk(sw*2,Math.floor(W*.16))]);
  const [mL,mM,mR]=await Promise.all([sharp(cL).metadata(),sharp(cM).metadata(),sharp(cR).metadata()]);
  const sc=(v,max)=>Math.max(0,Math.min(max,Math.round(v)));
  const rd=range=>Math.floor((Math.random()-.5)*range);

  return sharp(selfieBase).composite([
    {input:cL,blend:'over',left:sc(W*.05+rd(50),W-mL.width),top:sc(H*.72+rd(40),H-mL.height)},
    {input:cR,blend:'over',left:sc(W*.65+rd(50),W-mR.width),top:sc(H*.70+rd(40),H-mR.height)},
    {input:cM,blend:'over',left:sc(W*.20+rd(40),W-mM.width),top:sc(H*.22+rd(30),H-mM.height)},
  ]).jpeg({quality:93}).toBuffer();
}

// ── 工具 ──────────────────────────────────────────────────────
async function resizeImage(buf, maxWidth) {
  return sharp(buf).resize({width:maxWidth,withoutEnlargement:true}).jpeg({quality:88}).toBuffer();
}

async function downloadLineImageWithRetry(messageId, maxRetries=3) {
  const url='https://api-data.line.me/v2/bot/message/'+messageId+'/content';
  for (let i=1;i<=maxRetries;i++) {
    try {
      const res=await axios({method:'GET',url,
        headers:{Authorization:'Bearer '+getToken(),'User-Agent':'pikmin-bot/10.0'},
        responseType:'arraybuffer',timeout:20000,maxContentLength:20*1024*1024});
      if (!res.data||res.data.byteLength===0) throw new Error('空回應');
      return Buffer.from(res.data);
    } catch(err) {
      console.error('[DL] #'+i+' HTTP='+(err.response?.status||'N/A')+' '+err.message);
      if (i===maxRetries) throw err;
      await sleep(i*1000);
    }
  }
}

async function uploadToImgurWithRetry(b64, maxRetries=3) {
  for (let i=1;i<=maxRetries;i++) {
    try {
      const res=await axios.post('https://api.imgur.com/3/image',{image:b64,type:'base64'},
        {headers:{Authorization:'Client-ID '+IMGUR_CLIENT_ID,'Content-Type':'application/json'},timeout:30000});
      if (!res.data?.success) throw new Error('Imgur: '+JSON.stringify(res.data));
      return res.data.data.link.replace('http://','https://');
    } catch(err) {
      console.error('[IMGUR] #'+i+' 失敗:',err.message);
      if (i===maxRetries) throw err;
      await sleep(i*1500);
    }
  }
}

function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

async function replyMsg(replyToken,text){
  try{await getClient().replyMessage({replyToken,messages:[{type:'text',text}]});}
  catch(e){console.error('[REPLY]',e.message);}
}
async function pushMsg(userId,text){
  try{await getClient().pushMessage({to:userId,messages:[{type:'text',text}]});}
  catch(e){console.error('[PUSH]',e.message);}
}
async function pushImg(userId,imageUrl){
  try{await getClient().pushMessage({to:userId,messages:[{type:'image',originalContentUrl:imageUrl,previewImageUrl:imageUrl}]});}
  catch(e){console.error('[PUSH IMG]',e.message);}
}

function getGuideText(step){
  return ({
    wait_pikmin:'👋 歡迎使用皮克敏合照機器人！\n\n步驟：\n1️⃣ 傳送皮克敏截圖（AI 解析角色特徵）\n2️⃣ 傳送你的照片\n3️⃣ 取得 AR 合照 ✨\n\n輸入「重來」可重設\n\n➡️ 請傳送皮克敏截圖！',
    analyzing:'🔍 AI 正在分析角色特徵，請稍候...',
    wait_selfie:'✅ 角色解析完成！\n\n➡️ 請傳送你的照片 📸',
    generating:'⏳ 正在生成合照，請稍候...',
  })[step]||'➡️ 請傳送皮克敏截圖！';
}

app.listen(PORT,()=>{
  console.log('\n🌿 皮克敏合照 Bot v10 啟動！Port='+PORT);
  const checks={LINE_CHANNEL_ACCESS_TOKEN:getToken(),LINE_CHANNEL_SECRET:getSecret(),GEMINI_API_KEY:getGemini()};
  let ok=true;
  for(const[k,v]of Object.entries(checks)){
    if(!v){console.error('❌ 缺少: '+k);ok=false;}
    else console.log('✅ '+k+' (len='+v.length+')');
  }
  console.log(ok?'\n🚀 就緒！\n':'\n⚠️ 缺少環境變數！\n');
  console.log('🔍 診斷工具: https://你的Render網址/debug\n');
});
