#!/usr/bin/env node
/**
 * 音乐年龄测试 · 网站后端
 * 零额外依赖（Node 原生 http），数据层复用 NeteaseCloudMusicApi。
 *
 * 接口：
 *   GET  /api/health            健康检查
 *   GET  /api/resolve?url=...   主页链接/短链接 -> 用户 ID
 *   GET  /api/user?uid=...      用户资料 + 全部歌单列表（喜欢/自建/收藏分类）
 *   GET  /api/playlist?id=...   任意歌单的全量 trackIds
 *   POST /api/songs {ids:[..]}  批量取歌曲发行年份（单次 <= 1000 首）
 *
 * 计算（音乐年龄）由前端完成，后端只负责取数，便于部署到任何 Node 托管。
 * 本地运行：node server.js  （端口读 PORT，默认 3000）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const api = require('NeteaseCloudMusicApi');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const BASE = {
  proxy: process.env.https_proxy || process.env.HTTPS_PROXY || '',
  realIP: true,
};
const CURRENT_YEAR = new Date().getFullYear();

// 歌曲年份缓存：同一首歌被重复测到时直接命中，避免重复请求网易云
const songCache = new Map();
const CACHE_LIMIT = 60000;

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label}超时，请重试`)), ms)),
  ]);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 网易云偶尔会临时掐断连接（aborted）或限流，带退避重试能显著提高成功率
async function callApi(fn, label, timeoutMs = 30000) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await withTimeout(fn(), timeoutMs, label);
    } catch (e) {
      lastErr = e;
      const code = e && e.body && e.body.code;
      if (code === -462) break; // 触发验证时重试无意义
      if (attempt < 3) await sleep(attempt * 1500);
    }
  }
  throw lastErr;
}

function mapApiError(e) {
  const code = e && e.body && e.body.code;
  const msg = (e && e.body && (e.body.message || e.body.msg)) || (e && e.message) || '未知错误';
  if (code === -462 || /验证/.test(msg)) {
    return { status: 503, error: '网易云触发了访问验证，请过几分钟再试。' };
  }
  if (code === 301 || code === -301) {
    return { status: 403, error: '网易云要求登录后才能查看，可能该用户的喜欢歌单未公开。' };
  }
  return { status: 502, error: `网易云接口出错：${msg}` };
}

async function resolveUid(input) {
  const s = String(input || '').trim();
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/[?&#]id=(\d+)/);
  if (m) return m[1];
  if (/^https?:\/\//.test(s)) {
    const res = await withTimeout(fetch(s, { redirect: 'follow' }), 15000, '短链接解析');
    const m2 = res.url.match(/[?&#]id=(\d+)/);
    if (m2) return m2[1];
  }
  throw Object.assign(new Error('无法从链接中解析出用户 ID，请粘贴网易云音乐主页链接（形如 music.163.com/user/home?id=数字，或 App 分享的短链接）'), { httpStatus: 400 });
}

// 取一个歌单的全量 trackIds：playlist_detail 的 trackIds 通常是完整的，不足时用 track/all 分页补齐
async function getFullPlaylist(id) {
  const pd = await callApi(() => api.playlist_detail({ id, ...BASE }), '歌单详情查询');
  const pl = pd.body.playlist;
  let trackIds = (pl.trackIds || []).map((t) => t.id);
  if (trackIds.length < pl.trackCount) {
    const seen = new Set(trackIds);
    for (let offset = 0; offset < pl.trackCount && offset < 50000; offset += 1000) {
      const ta = await callApi(() => api.playlist_track_all({ id, limit: 1000, offset, ...BASE }), '歌单分页查询');
      const songs = ta.body.songs || [];
      for (const s of songs) if (!seen.has(s.id)) { seen.add(s.id); trackIds.push(s.id); }
      if (!songs.length) break;
    }
  }
  return { id: pl.id, name: pl.name, trackCount: pl.trackCount, trackIds };
}

async function handleUser(res, uid) {
  if (!/^\d+$/.test(uid || '')) return sendJson(res, 400, { error: '用户 ID 不合法' });
  try {
    const ud = await callApi(() => api.user_detail({ uid, ...BASE }), '用户信息查询');
    const profile = ud.body.profile;
    // 分页取全部歌单（喜欢的 + 自建的 + 收藏的），供前端多选
    const all = [];
    for (let offset = 0; ; offset += 100) {
      const up = await callApi(() => api.user_playlist({ uid, limit: 100, offset, ...BASE }), '歌单列表查询');
      const list = up.body.playlist || [];
      all.push(...list);
      if (!up.body.more || !list.length) break;
    }
    if (!all.length) {
      return sendJson(res, 404, { error: '没有找到任何公开歌单。可能对方把歌单都设为了隐私——在网易云 App 里把歌单设为公开后即可测试。' });
    }
    const playlists = all.map((p) => ({
      id: p.id,
      name: p.name,
      trackCount: p.trackCount,
      coverImgUrl: p.coverImgUrl || '',
      kind: p.specialType === 5 ? 'liked' : p.subscribed ? 'subscribed' : 'own',
    }));
    sendJson(res, 200, {
      nickname: profile.nickname,
      avatarUrl: profile.avatarUrl || '',
      level: ud.body.level,
      playlists,
    });
  } catch (e) {
    const m = mapApiError(e);
    sendJson(res, m.status, { error: m.error });
  }
}

async function handlePlaylist(res, id) {
  if (!/^\d+$/.test(id || '')) return sendJson(res, 400, { error: '歌单 ID 不合法' });
  try {
    const data = await getFullPlaylist(Number(id));
    sendJson(res, 200, data);
  } catch (e) {
    const m = mapApiError(e);
    sendJson(res, m.status, { error: m.error });
  }
}

async function handleSongs(req, res) {
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
  req.on('end', async () => {
    try {
      const { ids } = JSON.parse(raw || '{}');
      if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || !ids.every((i) => Number.isInteger(i) || /^\d+$/.test(i))) {
        return sendJson(res, 400, { error: '参数不合法：ids 应为 1~1000 个歌曲 ID' });
      }
      const out = new Array(ids.length);
      const missing = [];
      ids.forEach((id, idx) => {
        const hit = songCache.get(Number(id));
        if (hit) out[idx] = hit; else missing.push({ id, idx });
      });
      if (missing.length) {
        const sd = await callApi(
          () => api.song_detail({ ids: missing.map((m) => m.id).join(','), ...BASE }),
          '歌曲详情查询',
          45000,
        );
        const byId = new Map((sd.body.songs || []).map((s) => [s.id, s]));
        for (const { id, idx } of missing) {
          const s = byId.get(Number(id));
          let item;
          if (s) {
            const ts = (s.al && s.al.publishTime) || s.publishTime;
            const year = ts ? new Date(ts).getFullYear() : null;
            item = {
              id: s.id,
              name: s.name,
              artist: (s.ar || []).map((a) => a.name).join(' / '),
              year: year && year >= 1900 && year <= CURRENT_YEAR ? year : null,
            };
          } else {
            item = { id: Number(id), name: '', artist: '', year: null };
          }
          if (songCache.size > CACHE_LIMIT) songCache.clear();
          songCache.set(Number(id), item);
          out[idx] = item;
        }
      }
      sendJson(res, 200, { songs: out });
    } catch (e) {
      const m = mapApiError(e);
      sendJson(res, m.status, { error: m.error });
    }
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (req.method === 'OPTIONS' && pathname.startsWith('/api/')) return sendJson(res, 204, {});
  if (pathname === '/api/health') return sendJson(res, 200, { ok: true });
  if (pathname === '/api/resolve' && req.method === 'GET') {
    try {
      const uid = await resolveUid(url.searchParams.get('url') || '');
      return sendJson(res, 200, { uid });
    } catch (e) {
      return sendJson(res, e.httpStatus || 502, { error: e.message });
    }
  }
  if (pathname === '/api/user' && req.method === 'GET') return handleUser(res, url.searchParams.get('uid'));
  if (pathname === '/api/playlist' && req.method === 'GET') return handlePlaylist(res, url.searchParams.get('id'));
  if (pathname === '/api/songs' && req.method === 'POST') return handleSongs(req, res);
  if (pathname.startsWith('/api/')) return sendJson(res, 404, { error: '接口不存在' });

  // 静态文件
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Not Found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => console.log(`音乐年龄测试已启动：http://localhost:${PORT}`));
