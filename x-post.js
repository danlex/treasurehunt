// Direct X post with image via OAuth 1.0a user context.
//   1. Upload media via v1.1 /1.1/media/upload.json (multipart)
//   2. Post tweet via v2 /2/tweets with media_ids
// Credentials loaded from .env:
//   X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_TOKEN_SECRET

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;

function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (!m) continue;
    const [, key, rawVal = ''] = m;
    if (process.env[key] != null) continue;
    process.env[key] = rawVal.replace(/^['"]|['"]$/g, '');
  }
}
loadEnv();

// ─── OAuth 1.0a signing ───────────────────────────────────────────────
function percentEncode(str) {
  return encodeURIComponent(str).replace(/[!*'()]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function oauthHeader({ method, url, params = {}, creds }) {
  const oauth = {
    oauth_consumer_key:     creds.apiKey,
    oauth_nonce:            crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp:        Math.floor(Date.now() / 1000).toString(),
    oauth_token:            creds.accessToken,
    oauth_version:          '1.0',
  };
  const all = { ...oauth, ...params };
  const sortedEncoded = Object.keys(all).sort()
    .map(k => `${percentEncode(k)}=${percentEncode(all[k])}`)
    .join('&');
  const baseString = [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(sortedEncoded),
  ].join('&');
  const signingKey = `${percentEncode(creds.apiSecret)}&${percentEncode(creds.accessSecret)}`;
  const signature = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');
  oauth.oauth_signature = signature;
  return 'OAuth ' + Object.keys(oauth).sort()
    .map(k => `${percentEncode(k)}="${percentEncode(oauth[k])}"`)
    .join(', ');
}

function getCreds() {
  const creds = {
    apiKey:       process.env.X_API_KEY,
    apiSecret:    process.env.X_API_SECRET,
    accessToken:  process.env.X_ACCESS_TOKEN,
    accessSecret: process.env.X_ACCESS_TOKEN_SECRET,
  };
  for (const k of Object.keys(creds)) {
    if (!creds[k]) throw new Error(`missing .env var for ${k}`);
  }
  return creds;
}

// ─── Media upload (v1.1, multipart) ───────────────────────────────────
async function uploadMedia(imagePath, creds) {
  const url = 'https://upload.twitter.com/1.1/media/upload.json';
  const fileBuf = fs.readFileSync(imagePath);
  const mime = /\.jpe?g$/i.test(imagePath) ? 'image/jpeg'
             : /\.webp$/i.test(imagePath) ? 'image/webp'
             : 'image/png';

  // Multipart-body: only the OAuth header is signed (not the file content),
  // so we pass no body params to oauthHeader.
  const boundary = '----th-' + crypto.randomBytes(8).toString('hex');
  const CRLF = '\r\n';
  const head = `--${boundary}${CRLF}` +
    `Content-Disposition: form-data; name="media"; filename="${path.basename(imagePath)}"${CRLF}` +
    `Content-Type: ${mime}${CRLF}${CRLF}`;
  const tail = `${CRLF}--${boundary}--${CRLF}`;
  const body = Buffer.concat([Buffer.from(head, 'utf8'), fileBuf, Buffer.from(tail, 'utf8')]);

  const auth = oauthHeader({ method: 'POST', url, creds });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization:  auth,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`media upload ${res.status}: ${text.slice(0, 400)}`);
  const json = JSON.parse(text);
  return json.media_id_string || json.media_id;
}

// ─── Tweet post (v2) ──────────────────────────────────────────────────
async function postTweet({ text, mediaIds, creds }) {
  const url = 'https://api.x.com/2/tweets';
  // v2 JSON body is NOT included in OAuth signature base.
  const auth = oauthHeader({ method: 'POST', url, creds });
  const body = { text };
  if (mediaIds && mediaIds.length) body.media = { media_ids: mediaIds };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization:  auth,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const respText = await res.text();
  if (!res.ok) throw new Error(`tweet ${res.status}: ${respText.slice(0, 500)}`);
  const json = JSON.parse(respText);
  return json.data; // { id, text, ... }
}

// ─── Public: post a tweet with optional image ─────────────────────────
async function postWithImage({ text, imagePath }) {
  const creds = getCreds();
  let mediaIds = [];
  if (imagePath && fs.existsSync(imagePath)) {
    const mediaId = await uploadMedia(imagePath, creds);
    mediaIds = [mediaId];
  }
  const tweet = await postTweet({ text, mediaIds, creds });
  return {
    tweetId: tweet.id,
    tweetUrl: `https://x.com/i/web/status/${tweet.id}`,
    mediaIds,
  };
}

module.exports = { postWithImage, uploadMedia, postTweet };

if (require.main === module) {
  const id = process.argv[2];
  const { composeTweet } = require('./tweet');
  if (!id) { console.error('usage: node x-post.js <item-id>'); process.exit(1); }
  const all = [
    ...JSON.parse(fs.readFileSync('posts.json', 'utf8')),
    ...JSON.parse(fs.readFileSync('queue.json', 'utf8')),
  ];
  const item = all.find(x => x.id === id);
  if (!item) { console.error('no item'); process.exit(2); }
  const text = composeTweet(item);
  let imagePath = null;
  for (const ext of ['.jpg', '.png', '.webp']) {
    const p = path.join(ROOT, 'presentations', 'assets', `${id}-0${ext}`);
    if (fs.existsSync(p)) { imagePath = p; break; }
  }
  console.log('TEXT:', text);
  console.log('IMG:', imagePath);
  (async () => {
    try {
      const r = await postWithImage({ text, imagePath });
      console.log(JSON.stringify(r, null, 2));
    } catch (e) {
      console.error('failed:', e.message);
      process.exit(3);
    }
  })();
}
