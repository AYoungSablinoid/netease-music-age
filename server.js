#!/usr/bin/env node
/**
 * 音乐年龄测试 · 网站后端
 * 零额外依赖（Node 原生 http），数据层复用 NeteaseCloudMusicApi。
 *
 * 接口：
 *   GET  /api/health            健康检查
 *   GET  /api/resolve?url=...   主页链接/短链接 -> 用户 ID
 *   GET  /api/user?uid=...      用户资料 + 全部歌单列表（按创建者区分喜欢/自建/收藏）
 *   GET  /api/playlist?id=...   任意歌单的全量 trackIds
 *   GET  /api/record?uid=...    听歌排行：最近一周 + 历史播放最高（对方未公开时 available:false）
 *   POST /api/songs {ids:[..]}  批量取歌曲发行年份（单次 <= 1000 首）
 *   POST /api/original-years    对重制/再版/精选专辑的歌，查同歌手同名歌曲的最早发行年份
 *   GET  /api/qq/user?uin=...   QQ 音乐用户公开自建歌单（uin 可为 QQ 号或主页加密 uin）
 *   GET  /api/qq/resolve-share?token=...  解析 QQ 音乐 App 分享链接（u?__= 跳转）的落点：歌单或用户
 *   GET  /api/qq/playlist?id=.. QQ 音乐歌单全部歌曲（含专辑 mid，不含年份）
 *   POST /api/qq/album-years    按专辑 mid 批量补发行年份 {mids:[..]}（单次 <= 100）
 *   GET  /api/kuwo/user?uid=... 酷我用户公开歌单（老服务按 uid 列单，含「我喜欢听」）
 *   GET  /api/kuwo/playlist?id= 酷我歌单全部歌曲（逐曲自带发行年份）
 *   GET  /api/kugou/playlist?id= 酷狗老式歌单全部歌曲（带专辑 ID，不含年份）
 *   POST /api/kugou/album-years  按专辑 ID 批量补发行年份 {ids:[..]}（单次 <= 100）
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
// attempts 可调：校正用的搜索失败只是少校正一首，不值得像主流程那样反复重试拖慢整体
async function callApi(fn, label, timeoutMs = 30000, attempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await withTimeout(fn(), timeoutMs, label);
    } catch (e) {
      lastErr = e;
      const code = e && e.body && e.body.code;
      if (code === -462) break; // 触发验证时重试无意义
      if (attempt < attempts) await sleep(attempt * 1200);
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
    // 分页取全部歌单（喜欢的 + 自建的 + 收藏的），供前端多选。
    // 每波并发取 3 页（歌单 300+ 的用户串行取要 5 秒以上，并发后约 1/3）；
    // 按 offset 顺序合并，遇到 more=false 或空页就停（最多多发 2 个越界请求，接口返回空列表）。
    const all = [];
    let waveStart = 0;
    let done = false;
    while (!done) {
      const offsets = [waveStart, waveStart + 100, waveStart + 200];
      const pages = await Promise.all(offsets.map((offset) =>
        callApi(() => api.user_playlist({ uid, limit: 100, offset, ...BASE }), '歌单列表查询')));
      for (const up of pages) {
        const list = up.body.playlist || [];
        all.push(...list);
        if (!up.body.more || !list.length) { done = true; break; }
      }
      waveStart += 300;
    }
    if (!all.length) {
      return sendJson(res, 404, { error: '没有找到任何公开歌单。可能对方把歌单都设为了隐私——在网易云 App 里把歌单设为公开后即可测试。' });
    }
    // 分类不能看 subscribed 字段：匿名请求时它恒为 null。
    // 可靠依据是创建者：creator.userId 等于本人 => 自建，否则就是收藏的别人歌单。
    const playlists = all.map((p) => {
      const creatorId = p.creator && p.creator.userId;
      return {
        id: p.id,
        name: p.name,
        trackCount: p.trackCount,
        coverImgUrl: p.coverImgUrl || '',
        creatorName: (p.creator && p.creator.nickname) || '',
        kind: p.specialType === 5 ? 'liked' : String(creatorId) === String(uid) ? 'own' : 'subscribed',
      };
    });
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

// 听歌排行：type=1 最近一周，type=0 历史累计（接口本身按播放量从高到低返回，最多 100 条）
// 这是网易云的公开数据（用户可在 App 里设置可见性）；未公开时接口返回 -2，这里转成 available:false，不算错误
async function handleRecord(res, uid) {
  if (!/^\d+$/.test(uid || '')) return sendJson(res, 400, { error: '用户 ID 不合法' });
  const fetchChart = async (type) => {
    const r = await callApi(() => api.user_record({ uid, type, ...BASE }), '听歌排行查询');
    const list = (type === 1 ? r.body.weekData : r.body.allData) || [];
    return list.map((it) => ({ id: it.song.id, playCount: it.playCount || 0 }));
  };
  try {
    const week = await fetchChart(1);
    const top = await fetchChart(0);
    if (!week.length && !top.length) {
      return sendJson(res, 200, { available: false, reason: '对方的听歌排行是空的' });
    }
    sendJson(res, 200, { available: true, week, top });
  } catch (e) {
    const code = e && e.body && e.body.code;
    if (code === -2 || code === 301 || code === -301) {
      return sendJson(res, 200, { available: false, reason: '对方未公开听歌排行（可在网易云 App 设置里公开）' });
    }
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
              album: (s.al && s.al.name) || '',
              year: year && year >= 1900 && year <= CURRENT_YEAR ? year : null,
            };
            // 顺手记下专辑年份：校正时搜到的候选若在这张专辑里，直接命中、不用再发详情请求
            if (s.al && s.al.id && item.year) {
              if (albumYearCache.size > 60000) albumYearCache.clear();
              albumYearCache.set(s.al.id, item.year);
            }
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

// ---- 重制/再版歌曲的年份校正 ----
// 有些歌所在的专辑是重制版、再版或精选集，专辑发行年份晚于歌曲本身的原版年份，
// 直接用专辑年份会把音乐年龄算小。对这类歌，改用「同歌手 + 同名歌曲的最早版本年份」。
const FLAG_RE = /remaster|重制|复刻|deluxe|anniversary|reissue|expanded|special edition|纪念版|豪华版|精选|greatest hits|best of|collection|anthology|essential|金曲|\bhits\b|ultimate|definitive/i;
function isFlagged(name, album) { return FLAG_RE.test(`${name || ''} ${album || ''}`); }

function cleanTitle(t) {
  return String(t || '')
    .replace(/[（(][^）)]*(remaster|remix|live|edit|version|ver\.?|deluxe)[^）)]*[）)]/gi, '')
    .replace(/[-–—]\s*(remaster|remix).*$/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
const normName = (s) => String(s || '').toLowerCase().replace(/[\s・·.\-_]/g, '');

const originalYearCache = new Map(); // 「清洗歌名|歌手」-> 最早版本年份（null 表示确认没有更早版本）
const albumYearCache = new Map(); // 专辑 ID -> 发行年份（由 /api/songs 的详情顺手填充，校正时命中就不用再查）

// 全局搜索信号量：不管同时进来几个校正请求，cloudsearch 并发都压在 8 以内。
// 实测（80 组基准）：并发 8 时一轮搜索约 27 秒，并发 5 约 47 秒、并发 3 约 78 秒；
// 再高容易触发网易云/代理的 aborted 限流， retries 会把收益吃掉。
let searchInFlight = 0;
const searchWaiters = [];
async function withSearchSlot(fn) {
  if (searchInFlight >= 8) await new Promise((r) => searchWaiters.push(r));
  searchInFlight++;
  try { return await fn(); } finally {
    searchInFlight--;
    const w = searchWaiters.shift();
    if (w) w();
  }
}

async function searchCandidates(name, artist) {
  const base = cleanTitle(name);
  const r = await withSearchSlot(() => callApi(
    () => api.cloudsearch({ keywords: `${base} ${artist}`, type: 1, limit: 30, ...BASE }),
    '原版年份搜索', 20000, 3,
  ));
  return ((r.body.result && r.body.result.songs) || [])
    .filter((s) => cleanTitle(s.name) === base && (s.ar || []).some((a) => normName(a.name) === normName(artist)))
    .map((s) => ({ id: s.id, albumId: s.al ? s.al.id : 0 }));
}

// 批量解析一组疑似歌曲的最早版本年份。旧做法是逐首「搜索+详情」两次往返，
// 几百首就是上千次小请求；新做法分三段：
//   1) 按「清洗歌名+歌手」分组（同歌多版本只搜一次），并发搜索拿候选（只拿 ID 和专辑 ID）；
//   2) 候选按专辑去重（同专辑年份相同，只留一个代表），不在 albumYearCache 里的专辑
//      合并成 500 个一批的 song/detail 大请求——80 组实测详情请求从 88 次降到 1 次；
//   3) 每组在候选专辑年份里取最小值。年份一律以详情接口返回的专辑 ID 为准入缓存，避免两端专辑 ID 不一致时张冠李戴。
// 返回与入参等长的数组，每项为最早年份或 null；搜索失败的组返回 null 且不写缓存。
async function resolveOriginalYears(items) {
  const groups = new Map();
  items.forEach((s, i) => {
    const key = `${cleanTitle(s.name)}|${normName(s.artist)}`;
    if (!groups.has(key)) groups.set(key, { name: s.name, artist: s.artist, idxs: [] });
    groups.get(key).idxs.push(i);
  });
  const groupList = [...groups.entries()];
  const earliestByKey = new Map();
  const needSearch = [];
  for (const [key, g] of groupList) {
    if (originalYearCache.has(key)) earliestByKey.set(key, originalYearCache.get(key));
    else needSearch.push([key, g]);
  }
  // 1) 并发搜索
  const candByKey = new Map();
  const failedKeys = new Set();
  let nextIdx = 0;
  const worker = async () => {
    while (nextIdx < needSearch.length) {
      const [key, g] = needSearch[nextIdx++];
      try { candByKey.set(key, await searchCandidates(g.name, g.artist)); }
      catch (e) { candByKey.set(key, []); failedKeys.add(key); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(8, needSearch.length) }, worker));
  // 2) 专辑去重 + 批量详情
  const repByAlbum = new Map();
  for (const cands of candByKey.values()) {
    for (const c of cands) if (c.albumId && !repByAlbum.has(c.albumId)) repByAlbum.set(c.albumId, c.id);
  }
  const needAlbums = [...repByAlbum.entries()].filter(([aid]) => !albumYearCache.has(aid));
  const songYearById = new Map();
  for (let i = 0; i < needAlbums.length; i += 500) {
    const batch = needAlbums.slice(i, i + 500);
    try {
      const sd = await callApi(
        () => api.song_detail({ ids: batch.map(([, id]) => id).join(','), ...BASE }),
        '原版年份详情', 30000, 3,
      );
      for (const s of sd.body.songs || []) {
        const ts = (s.al && s.al.publishTime) || s.publishTime;
        if (!ts) continue;
        const y = new Date(ts).getFullYear();
        if (y < 1900 || y > CURRENT_YEAR) continue;
        songYearById.set(s.id, y);
        if (s.al && s.al.id) albumYearCache.set(s.al.id, y);
      }
    } catch (e) { /* 这一批详情失败，对应组按查不到处理，不写缓存 */ }
  }
  if (albumYearCache.size > 60000) albumYearCache.clear();
  // 3) 汇总每组最早年份
  for (const [key, cands] of candByKey) {
    let earliest = null;
    for (const c of cands) {
      const y = songYearById.get(c.id) ?? (c.albumId ? albumYearCache.get(c.albumId) : null);
      if (y && (!earliest || y < earliest)) earliest = y;
    }
    earliestByKey.set(key, earliest);
    if (!failedKeys.has(key)) {
      if (originalYearCache.size > 20000) originalYearCache.clear();
      originalYearCache.set(key, earliest);
    }
  }
  const out = new Array(items.length).fill(null);
  for (const [key, g] of groupList) {
    const earliest = earliestByKey.get(key);
    for (const i of g.idxs) out[i] = earliest ?? null;
  }
  return out;
}

// 只校正「最早版本比当前计入年份早 3 年以上」的情况，过滤掉一两年的噪声
async function handleOriginalYears(req, res) {
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
  req.on('end', async () => {
    try {
      const { songs } = JSON.parse(raw || '{}');
      if (!Array.isArray(songs) || !songs.length || songs.length > 50 || !songs.every((s) => s && typeof s.name === 'string')) {
        return sendJson(res, 400, { error: '参数不合法：songs 应为 1~50 首' });
      }
      // 疑似判定由调用方负责（关键词标记，或同一批歌里已有更早的同名同歌手版本且可内部直判的不送过来）；
      // 这里对送来的歌批量查最早版本，不再重复关键词过滤，避免漏掉专辑名不带关键词的精选集
      const items = songs.map((s) => ({ name: s.name, artist: s.artist, year: s.year }));
      const earliestList = await resolveOriginalYears(items);
      const results = songs.map((s, i) => {
        const earliest = earliestList[i];
        return { originalYear: s.year && earliest && earliest <= s.year - 3 ? earliest : null };
      });
      sendJson(res, 200, { results });
    } catch (e) {
      const m = mapApiError(e);
      sendJson(res, m.status, { error: m.error });
    }
  });
}

// ---- QQ 音乐数据源 ----
// 与网易云不同，QQ 音乐没有官方匿名 API，走的是网页端只读接口（g_tk=5381 + Referer 即可，
// 不需要任何人的登录凭证，前提是对方主页/歌单公开）：
//   用户创建歌单：c.y.qq.com/rsc/fcgi-bin/fcg_user_created_diss（hostuin 可为 QQ 号或主页链接里的加密 uin）
//   歌单歌曲：    c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp（返回歌名/歌手/专辑 mid，无年份）
//   专辑年份：    c.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp（aDate 为发行日期，按去重专辑补查）
// 注意：「我喜欢」在 QQ 音乐需要登录态才能读，匿名拿不到，本站 QQ 模式只支持自建歌单 + 公开歌单链接。
const QQ_HEADERS = {
  Referer: 'https://y.qq.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
};
const qqAlbumYearCache = new Map(); // albummid -> 发行年份（null 表示查过但无日期）

function decodeHtmlEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}

async function qqCall(url, label, timeoutMs = 20000, attempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const r = await withTimeout(fetch(url, { headers: QQ_HEADERS }), timeoutMs, label);
      const text = await r.text();
      const data = JSON.parse(text);
      if (data.code !== 0) throw Object.assign(new Error(`${label}返回 code=${data.code}`), { qqCode: data.code });
      return data;
    } catch (e) {
      lastErr = e;
      if (attempt < attempts) await sleep(attempt * 1000);
    }
  }
  throw lastErr;
}

const QQ_BASE_QS = 'g_tk=5381&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0';

async function qqUserPlaylists(uin) {
  const all = [];
  let nickname = '';
  for (let sin = 0; ; sin += 100) {
    const d = await qqCall(
      `https://c.y.qq.com/rsc/fcgi-bin/fcg_user_created_diss?hostuin=${encodeURIComponent(uin)}&sin=${sin}&size=100&${QQ_BASE_QS}`,
      'QQ音乐歌单列表查询',
    );
    const data = d.data || {};
    if (data.hostname) nickname = decodeHtmlEntities(data.hostname);
    const list = data.disslist || [];
    all.push(...list);
    const total = data.totoal || 0; // 接口字段就拼作 totoal
    if (!list.length || (total && all.length >= total)) break;
  }
  // tid=0 的是 QZone 背景音乐之类的系统伪歌单，过滤掉
  const playlists = all
    .filter((p) => p.tid && Number(p.tid) > 0)
    .map((p) => ({
      id: String(p.tid),
      name: decodeHtmlEntities(p.diss_name),
      trackCount: p.song_cnt || 0,
      coverImgUrl: p.diss_cover || '',
      creatorName: nickname,
      kind: 'own',
    }));
  return { nickname, playlists };
}

async function qqPlaylistSongs(tid) {
  const d = await qqCall(
    `https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?type=1&json=1&utf8=1&onlysong=0&disstid=${encodeURIComponent(tid)}&${QQ_BASE_QS}`,
    'QQ音乐歌单详情查询',
  );
  const cd = (d.cdlist || [])[0];
  if (!cd) throw new Error('歌单不存在或未公开');
  const songs = (cd.songlist || []).map((s) => ({
    id: s.songmid || String(s.songid || ''),
    name: decodeHtmlEntities(s.songname),
    artist: (s.singer || []).map((a) => decodeHtmlEntities(a.name)).join(' / '),
    album: decodeHtmlEntities(s.albumname),
    albummid: s.albummid || '',
  })).filter((s) => s.id && s.name);
  return { name: decodeHtmlEntities(cd.dissname), songs };
}

async function qqAlbumYear(albummid) {
  if (qqAlbumYearCache.has(albummid)) return qqAlbumYearCache.get(albummid);
  let year = null;
  try {
    const d = await qqCall(
      `https://c.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg?albummid=${encodeURIComponent(albummid)}&${QQ_BASE_QS}`,
      'QQ音乐专辑查询', 15000, 2,
    );
    const m = /^(\d{4})/.exec((d.data && d.data.aDate) || '');
    if (m) {
      const y = Number(m[1]);
      if (y >= 1900 && y <= CURRENT_YEAR) year = y;
    }
  } catch (e) { /* 查不到就按无年份处理 */ }
  if (qqAlbumYearCache.size > 60000) qqAlbumYearCache.clear();
  qqAlbumYearCache.set(albummid, year);
  return year;
}

// QQ 音乐 App 的分享链接是 c6.y.qq.com/base/fcgi-bin/u?__=<token> 形式的跳转链接，
// 本身不带歌单/用户 ID；跟着跳转走，最终落点 URL 里才有 /playlist/<id> 或 uin。
// 用户只粘 __ 后面的 token 时也会走到这里（token 会先被误当加密 uin、接口报 code=2000，前端再回退到本接口）。
async function resolveQQShare(token) {
  const r = await withTimeout(fetch(`https://c6.y.qq.com/base/fcgi-bin/u?__=${encodeURIComponent(token)}`, {
    headers: { 'User-Agent': QQ_HEADERS['User-Agent'] },
  }), 20000, 'QQ分享链接解析');
  const finalUrl = r.url || '';
  try { await r.body.cancel(); } catch (e) { /* 忽略 */ }
  let m = finalUrl.match(/playlist\/(\d+)/);
  if (m) return { type: 'playlist', id: m[1] };
  m = finalUrl.match(/profile\/([\w*+=-]+)/) || finalUrl.match(/[?&](?:uin|hostuin)=([\w*+=-]+)/);
  if (m) return { type: 'user', uin: decodeURIComponent(m[1]) };
  return null;
}

async function handleQQResolveShare(res, token) {
  if (!token || !/^[\w=-]{4,128}$/.test(token)) return sendJson(res, 400, { error: '分享口令格式不对' });
  try {
    const r = await resolveQQShare(token);
    if (!r) return sendJson(res, 404, { error: '这个分享链接解析不出歌单或用户（可能已过期）' });
    sendJson(res, 200, r);
  } catch (e) {
    sendJson(res, 502, { error: `QQ音乐接口出错：${e.message}` });
  }
}

async function handleQQUser(res, uin) {
  if (!uin || !/^[\w*=-]{3,64}$/.test(uin)) return sendJson(res, 400, { error: 'QQ 号或主页标识不合法' });
  try {
    const { nickname, playlists } = await qqUserPlaylists(uin);
    if (!playlists.length) {
      return sendJson(res, 404, { error: '没有找到公开的自建歌单。可能对方主页未公开，或只有「我喜欢」（QQ 音乐的「我喜欢」需要登录才能读取，本站暂不支持）。' });
    }
    sendJson(res, 200, { nickname: nickname || 'QQ音乐用户', avatarUrl: '', level: null, playlists });
  } catch (e) {
    sendJson(res, 502, { error: `QQ 音乐接口出错：${e.message}` });
  }
}

async function handleQQPlaylist(res, id) {
  if (!/^\d+$/.test(id || '')) return sendJson(res, 400, { error: '歌单 ID 不合法' });
  try {
    const data = await qqPlaylistSongs(id);
    sendJson(res, 200, data);
  } catch (e) {
    sendJson(res, 502, { error: `QQ 音乐接口出错：${e.message}` });
  }
}

async function handleQQAlbumYears(req, res) {
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
  req.on('end', async () => {
    try {
      const { mids } = JSON.parse(raw || '{}');
      if (!Array.isArray(mids) || !mids.length || mids.length > 100 || !mids.every((m) => typeof m === 'string')) {
        return sendJson(res, 400, { error: '参数不合法：mids 应为 1~100 个专辑 mid' });
      }
      const years = {};
      let next = 0;
      const worker = async () => {
        while (next < mids.length) {
          const mid = mids[next++];
          years[mid] = await qqAlbumYear(mid);
        }
      };
      await Promise.all(Array.from({ length: Math.min(6, mids.length) }, worker));
      sendJson(res, 200, { years });
    } catch (e) {
      sendJson(res, 502, { error: `QQ 音乐接口出错：${e.message}` });
    }
  });
}

// ---- 酷我音乐数据源 ----
// 两段拼起来用（都是匿名、无需任何人的登录凭证，前提是歌单公开）：
//   列歌单：老服务 nplserver.kuwo.cn/pl.svc?op=getuserlist 按 uid 列出公开歌单（含「我喜欢听」MYFAVORITE、自建 GENERAL）；
//   取歌曲：www.kuwo.cn/api/www/playlist/playListInfo 分页取全量，逐曲自带 releaseDate（= 所属专辑发行日，
//           与网易云 album.publishTime 同口径，不用按专辑补查）。
// www 接口要带一个动态令牌：访问站点时 Set-Cookie 下发 Hm_Iuvt_* 令牌 cookie（名字会被轮换，必须现取），
// 请求头带 Cookie + csrf=<令牌值> + Secret=h(令牌值, 令牌名)，h() 是酷我前端 JS 的一段变换（下方为等价实现）。
// 注意：酷我网页端没有「用户主页链接」这种模型，入口只能是 uid 或歌单链接。
function kuwoH(t, e) {
  if (e == null || e.length <= 0) return null;
  let n = '';
  for (let i = 0; i < e.length; i++) n += e.charCodeAt(i).toString();
  const r = Math.floor(n.length / 5);
  const o = parseInt(n.charAt(r) + n.charAt(2 * r) + n.charAt(3 * r) + n.charAt(4 * r) + n.charAt(5 * r));
  const l = Math.ceil(e.length / 2);
  const c = Math.pow(2, 31) - 1;
  if (o < 2) return null;
  let d = Math.round(1e9 * Math.random()) % 1e8;
  for (n += d; n.length > 10;) n = (parseInt(n.substring(0, 10)) + parseInt(n.substring(10, n.length))).toString();
  n = (o * n + l) % c;
  let f = '';
  for (let i = 0; i < t.length; i++) {
    const hv = parseInt(t.charCodeAt(i) ^ Math.floor((n / c) * 255));
    f += hv < 16 ? '0' + hv.toString(16) : hv.toString(16);
    n = (o * n + l) % c;
  }
  let ds = d.toString(16);
  for (; ds.length < 8;) ds = '0' + ds;
  return f + ds;
}

let kuwoTokenCache = null; // {name, value, cookie, secret, at}
async function kuwoToken(force) {
  if (!force && kuwoTokenCache && Date.now() - kuwoTokenCache.at < 10 * 60 * 1000) return kuwoTokenCache;
  const r = await withTimeout(fetch('https://www.kuwo.cn/', { headers: { 'User-Agent': QQ_HEADERS['User-Agent'] } }), 20000, '酷我令牌获取');
  const setCookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [];
  const pairs = setCookies.map((sc) => sc.split(';')[0].trim()).filter(Boolean);
  const tokenPair = pairs.find((p) => /^Hm_Iuvt_[^=]+=/.test(p));
  if (!tokenPair) throw new Error('没有拿到酷我令牌 cookie');
  const eq = tokenPair.indexOf('=');
  const name = tokenPair.slice(0, eq);
  const value = decodeURIComponent(tokenPair.slice(eq + 1));
  kuwoTokenCache = { name, value, cookie: pairs.join('; '), secret: kuwoH(value, name), at: Date.now() };
  return kuwoTokenCache;
}

async function kuwoWww(pathAndQuery, label) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const tk = await kuwoToken(attempt === 1);
    const r = await withTimeout(fetch('https://www.kuwo.cn' + pathAndQuery, {
      headers: {
        'User-Agent': QQ_HEADERS['User-Agent'],
        Referer: 'https://www.kuwo.cn/',
        Cookie: tk.cookie,
        csrf: tk.value,
        Secret: tk.secret,
      },
    }), 20000, label);
    const data = JSON.parse(await r.text());
    if (data && (data.code === 200 || data.success)) return data;
    if (attempt === 1) throw new Error(`${label}被酷我拒绝（${(data && data.message) || '未知原因'}）`);
  }
  throw new Error(`${label}失败`);
}

async function kuwoPlaylistSongs(pid) {
  const songs = [];
  let name = '';
  let total = Infinity;
  for (let pn = 1; songs.length < total; pn++) {
    const d = await kuwoWww(
      `/api/www/playlist/playListInfo?pid=${encodeURIComponent(pid)}&pn=${pn}&rn=100&httpsStatus=1&reqId=${crypto.randomUUID()}`,
      '酷我歌单查询',
    );
    const data = d.data || {};
    if (data.name) name = data.name;
    total = data.total || 0;
    const list = data.musicList || [];
    if (!list.length) break;
    for (const t of list) {
      const y = t.releaseDate === '1970-01-01' ? null : /^(\d{4})/.exec(t.releaseDate || ''); // 1970-01-01 是酷我的「日期未知」哨兵值
      songs.push({
        id: String(t.rid != null ? t.rid : (t.musicrid || '').replace(/^MUSIC_/, '')),
        name: decodeHtmlEntities(t.name),
        artist: decodeHtmlEntities(t.artist),
        album: decodeHtmlEntities(t.album),
        year: y ? Number(y[1]) : null,
      });
    }
    if (list.length < 100) break;
  }
  return { name, songs };
}

async function handleKuwoUser(res, uid) {
  if (!/^\d{3,15}$/.test(uid || '')) return sendJson(res, 400, { error: '酷我 uid 不合法（应为纯数字）' });
  try {
    const all = [];
    for (let pn = 0; ; pn++) {
      const url = `https://nplserver.kuwo.cn/pl.svc?op=getuserlist&uid=${uid}&userid=${uid}&pn=${pn}&rn=200&encode=utf8&keyset=pl2012&identity=kuwo&pcmp4=1&vipver=MUSIC_9.0.5.0_W1&newver=1`;
      let dd = null;
      let lastErr;
      for (let attempt = 1; attempt <= 3 && !dd; attempt++) {
        try {
          const r = await withTimeout(fetch(url, { headers: { 'User-Agent': QQ_HEADERS['User-Agent'] } }), 20000, '酷我歌单列表查询');
          dd = JSON.parse(await r.text());
        } catch (e) { lastErr = e; if (attempt < 3) await sleep(attempt * 1000); }
      }
      if (!dd) throw lastErr || new Error('酷我歌单列表查询失败');
      const plist = dd.plist || [];
      all.push(...plist);
      if (!plist.length || all.length >= (dd.total || 0)) break;
    }
    const playlists = all
      .filter((p) => (p.type === 'MYFAVORITE' || p.type === 'GENERAL') && p.ispub && !p.hidden)
      .map((p) => ({
        id: String(p.id),
        name: decodeHtmlEntities(p.title) || (p.type === 'MYFAVORITE' ? '我喜欢听' : '未命名歌单'),
        trackCount: p.musicnum || 0,
        coverImgUrl: '',
        creatorName: '',
        kind: p.type === 'MYFAVORITE' ? 'liked' : 'own',
      }));
    if (!playlists.length) {
      return sendJson(res, 404, { error: '没有找到公开的歌单。可能对方没有公开任何自建歌单或「我喜欢听」。' });
    }
    // 昵称：借第一个歌单的老接口详情拿 uname
    let nickname = '酷我用户';
    try {
      const r = await withTimeout(fetch(
        `http://nplserver.kuwo.cn/pl.svc?op=getlistinfo&pid=${playlists[0].id}&pn=0&rn=1&encode=utf8&keyset=pl2012&vipver=MUSIC_9.1.1.2_BCS2&newver=1`,
        { headers: { 'User-Agent': QQ_HEADERS['User-Agent'] } }), 15000, '酷我用户信息查询');
      const info = JSON.parse(await r.text());
      if (info.uname) nickname = info.uname;
    } catch (e) { /* 拿不到就用默认名 */ }
    sendJson(res, 200, { nickname, avatarUrl: '', level: null, playlists });
  } catch (e) {
    sendJson(res, 502, { error: `酷我接口出错：${e.message}` });
  }
}

async function handleKuwoPlaylist(res, id) {
  if (!/^\d+$/.test(id || '')) return sendJson(res, 400, { error: '歌单 ID 不合法' });
  try {
    const data = await kuwoPlaylistSongs(id);
    if (!data.songs.length) throw new Error('歌单不存在、未公开或没有歌曲');
    sendJson(res, 200, data);
  } catch (e) {
    sendJson(res, 502, { error: `酷我接口出错：${e.message}` });
  }
}

// ---- 酷狗音乐数据源（降级支持：仅老式数字 ID 歌单链接）----
// 酷狗没有可匿名枚举他人歌单的接口（用户歌单接口要主人本人的登录 token），主页模式做不了；
// 新版歌单（collection_ 开头）全量读取又需要整套签名 + 设备注册。这里只支持老式歌单：
//   歌单歌曲：mobilecdn.kugou.com/api/v3/special/song（零签名，filename 为「歌手 - 歌名」，带 album_id）
//   歌单信息：mobilecdn.kugou.com/api/v3/special/info（歌单名、曲数）
//   专辑年份：mobilecdn.kugou.com/api/v3/album/info 的 publishtime（模式同 QQ，按专辑补查）
const kgAlbumYearCache = new Map();

async function kgCall(url, label) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await withTimeout(fetch(url, { headers: { 'User-Agent': QQ_HEADERS['User-Agent'] } }), 20000, label);
      const d = JSON.parse(await r.text());
      if (d.status !== 1 || (d.errcode !== 0 && d.errcode != null)) throw new Error(`酷狗接口返回 status=${d.status} errcode=${d.errcode}`);
      return d;
    } catch (e) { lastErr = e; if (attempt < 3) await sleep(attempt * 1000); }
  }
  throw lastErr;
}

async function kugouPlaylistSongs(specialid) {
  const info = await kgCall(
    `http://mobilecdn.kugou.com/api/v3/special/info?specialid=${encodeURIComponent(specialid)}&version=9108&area_code=1`,
    '酷狗歌单信息查询',
  );
  const name = decodeHtmlEntities((info.data || {}).specialname || '');
  const songs = [];
  let total = Infinity;
  for (let page = 1; songs.length < total; page++) {
    const d = await kgCall(
      `http://mobilecdn.kugou.com/api/v3/special/song?specialid=${encodeURIComponent(specialid)}&page=${page}&pagesize=300&version=9108&area_code=1`,
      '酷狗歌单歌曲查询',
    );
    const data = d.data || {};
    total = data.total || 0;
    const list = data.info || [];
    if (!list.length) break;
    for (const t of list) {
      const fn = decodeHtmlEntities(t.filename || '');
      const sep = fn.indexOf(' - ');
      songs.push({
        id: t.hash || '',
        name: sep >= 0 ? fn.slice(sep + 3) : fn,
        artist: sep >= 0 ? fn.slice(0, sep) : '',
        album: '',
        albumid: t.album_id && String(t.album_id) !== '0' ? String(t.album_id) : '',
      });
    }
    if (list.length < 300) break;
  }
  return { name, songs: songs.filter((s) => s.id && s.name) };
}

async function kugouAlbumYear(albumid) {
  if (kgAlbumYearCache.has(albumid)) return kgAlbumYearCache.get(albumid);
  let year = null;
  try {
    const d = await kgCall(
      `http://mobilecdn.kugou.com/api/v3/album/info?albumid=${encodeURIComponent(albumid)}`,
      '酷狗专辑查询',
    );
    const mm = /^(\d{4})/.exec((d.data && d.data.publishtime) || '');
    if (mm) {
      const y = Number(mm[1]);
      if (y >= 1900 && y <= CURRENT_YEAR) year = y;
    }
  } catch (e) { /* 查不到就按无年份处理 */ }
  if (kgAlbumYearCache.size > 60000) kgAlbumYearCache.clear();
  kgAlbumYearCache.set(albumid, year);
  return year;
}

async function handleKugouPlaylist(res, id) {
  if (!/^\d+$/.test(id || '')) return sendJson(res, 400, { error: '歌单 ID 不合法（酷狗只支持老式数字 ID 歌单）' });
  try {
    const data = await kugouPlaylistSongs(id);
    if (!data.songs.length) throw new Error('歌单不存在或没有歌曲');
    sendJson(res, 200, data);
  } catch (e) {
    sendJson(res, 502, { error: `酷狗接口出错：${e.message}` });
  }
}

async function handleKugouAlbumYears(req, res) {
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
  req.on('end', async () => {
    try {
      const { ids } = JSON.parse(raw || '{}');
      if (!Array.isArray(ids) || !ids.length || ids.length > 100 || !ids.every((x) => typeof x === 'string')) {
        return sendJson(res, 400, { error: '参数不合法：ids 应为 1~100 个专辑 ID' });
      }
      const years = {};
      let next = 0;
      const worker = async () => {
        while (next < ids.length) {
          const id = ids[next++];
          years[id] = await kugouAlbumYear(id);
        }
      };
      await Promise.all(Array.from({ length: Math.min(6, ids.length) }, worker));
      sendJson(res, 200, { years });
    } catch (e) {
      sendJson(res, 502, { error: `酷狗接口出错：${e.message}` });
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
  if (pathname === '/api/record' && req.method === 'GET') return handleRecord(res, url.searchParams.get('uid'));
  if (pathname === '/api/songs' && req.method === 'POST') return handleSongs(req, res);
  if (pathname === '/api/original-years' && req.method === 'POST') return handleOriginalYears(req, res);
  if (pathname === '/api/qq/user' && req.method === 'GET') return handleQQUser(res, url.searchParams.get('uin'));
  if (pathname === '/api/qq/resolve-share' && req.method === 'GET') return handleQQResolveShare(res, url.searchParams.get('token'));
  if (pathname === '/api/qq/playlist' && req.method === 'GET') return handleQQPlaylist(res, url.searchParams.get('id'));
  if (pathname === '/api/qq/album-years' && req.method === 'POST') return handleQQAlbumYears(req, res);
  if (pathname === '/api/kuwo/user' && req.method === 'GET') return handleKuwoUser(res, url.searchParams.get('uid'));
  if (pathname === '/api/kuwo/playlist' && req.method === 'GET') return handleKuwoPlaylist(res, url.searchParams.get('id'));
  if (pathname === '/api/kugou/playlist' && req.method === 'GET') return handleKugouPlaylist(res, url.searchParams.get('id'));
  if (pathname === '/api/kugou/album-years' && req.method === 'POST') return handleKugouAlbumYears(req, res);
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
