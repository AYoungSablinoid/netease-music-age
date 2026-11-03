#!/usr/bin/env node
/**
 * 音乐年龄测试（中文版）· 命令行版
 * 输入网易云音乐主页链接 -> 取所选歌单的全部歌曲（跨歌单去重）
 * -> 按专辑发行年份换算音乐年龄：假设每首歌都是在发行那年 17 岁时听的，
 *    单曲音乐年龄 = 当前年份 - 发行年份 + 17，取全部平均。
 * 数据层基于开源项目 Binaryify/NeteaseCloudMusicApi（免登录，只读公开数据）。
 *
 * 用法: node music-age.js <主页链接|用户ID> [选项]
 *   （无选项）        只算「我喜欢的音乐」歌单
 *   --all             算「我喜欢的音乐」+ 全部自建歌单
 *   --ids=<id1,id2>   只算指定的歌单（ID 见 --list）
 *   --list            列出该用户的全部公开歌单后退出
 *   例: node music-age.js "https://music.163.com/user/home?id=1" --all
 *
 * QQ 音乐: node music-age.js --qq <QQ号|QQ音乐主页链接|歌单链接> [--list]
 *   数据来自 QQ 音乐网页端公开只读接口（匿名，前提是主页/歌单公开）；
 *   默认算全部公开自建歌单（QQ 的「我喜欢」需登录才能读，不在此列），年份按专辑补查。
 * 酷我音乐: node music-age.js --kuwo <酷我用户ID|歌单链接> [--list]
 *   列单走老服务按 uid 取公开歌单（含「我喜欢听」），取歌走 www 接口、逐曲自带发行年份。
 */
const fs = require('fs');
const path = require('path');
const api = require('NeteaseCloudMusicApi');

const PROXY = process.env.https_proxy || process.env.HTTPS_PROXY || '';
const BASE = { proxy: PROXY, realIP: true };
const CURRENT_YEAR = new Date().getFullYear();
const BATCH = 1000;

// 有上限的并发池：按原顺序返回结果
async function mapPool(items, conc, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, worker));
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 网易云偶尔会断连/限流（aborted、socket hang up、502 等），统一退避重试，与网站后端同一策略
function errText(e) {
  if (!e) return '未知错误';
  if (e.body && (e.body.msg || e.body.message)) return e.body.msg || e.body.message;
  return e.message || JSON.stringify(e);
}
function isTransient(e) {
  const msg = errText(e);
  if (/aborted|socket hang up|ECONNRESET|ETIMEDOUT|ECONNREFUSED|timeout/i.test(msg)) return true;
  if (e && (e.status === 502 || e.status === 503 || e.status === 429)) return true;
  if (e && e.body && (e.body.code === 502 || e.body.code === 503 || e.body.code === -462)) return true;
  return false;
}
async function callApi(fn, label, attempts = 4, timeoutMs = 0) {
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const p = fn();
      return timeoutMs
        ? await Promise.race([p, sleep(timeoutMs).then(() => { throw new Error('timeout'); })])
        : await p;
    } catch (e) {
      lastErr = e;
      if (!isTransient(e) || attempt === attempts - 1) break;
      await sleep(1000 * Math.pow(2, attempt));
    }
  }
  throw new Error(`${label}失败：${errText(lastErr)}`);
}

async function resolveUid(input) {
  const s = String(input).trim();
  if (/^\d+$/.test(s)) return s;
  const m = s.match(/[?&#]id=(\d+)/);
  if (m) return m[1];
  // 短链接等：跟随重定向后再解析
  try {
    const res = await fetch(s, { redirect: 'follow' });
    const m2 = res.url.match(/[?&#]id=(\d+)/);
    if (m2) return m2[1];
  } catch (e) { /* fall through */ }
  throw new Error('无法从链接中解析出用户 ID，请确认是网易云音乐主页链接（形如 music.163.com/user/home?id=数字）');
}

function generationLabel(age) {
  if (age <= 22) return 'Z 世代的耳朵';
  if (age <= 32) return '千禧一代的耳朵';
  if (age <= 42) return '80 后的耳朵';
  if (age <= 52) return '70 后的耳朵';
  if (age <= 62) return '泡沫经济世代的耳朵';
  return '黄金年代的耳朵';
}

// 分类不能看 subscribed 字段：匿名请求时它恒为 null。
// 可靠依据是创建者：creator.userId 等于本人 => 自建，否则就是收藏的别人歌单。
function kindOf(p, uid) {
  if (p.specialType === 5) return 'liked';
  const creatorId = p.creator && p.creator.userId;
  return String(creatorId) === String(uid) ? 'own' : 'subscribed';
}
const KIND_LABEL = { liked: '我喜欢的音乐', own: '自建', subscribed: '收藏' };

// ---- 重制/再版歌曲的年份校正（与网站后端同一套规则）----
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

const originalYearCache = new Map(); // 「清洗歌名|歌手」-> 最早版本年份
const albumYearCache = new Map(); // 专辑 ID -> 发行年份（由计入歌曲顺手填充，校正时命中就不用再查）

async function searchCandidates(name, artist) {
  const base = cleanTitle(name);
  const r = await callApi(
    () => api.cloudsearch({ keywords: `${base} ${artist}`, type: 1, limit: 30, ...BASE }),
    '原版年份搜索', 3, 20000,
  );
  return ((r.body.result && r.body.result.songs) || [])
    .filter((s) => cleanTitle(s.name) === base && (s.ar || []).some((a) => normName(a.name) === normName(artist)))
    .map((s) => ({ id: s.id, albumId: s.al ? s.al.id : 0 }));
}

// 只校正「最早版本比当前计入年份早 3 年以上」的情况，过滤掉一两年的噪声。原地改 year。
// 优化后的三段流水线（旧做法是逐组「搜索+详情」两次往返，600 组要上千次小请求、约 15 分钟）：
//   0) 内部直判：同一批歌里已有同名同歌手的干净原版（最早版本本身不带重制标记）时，
//      直接用批内最早年份校正，整组免搜索——凯的歌单实测 600 组里有 123 组可这样跳过；
//   1) 其余组按「清洗歌名+歌手」分组，8 路并发搜索只拿候选 ID（基准实测并发 8 最快，约是并发 3 的 3 倍）；
//   2) 候选按专辑去重后合并成 500 一批的大详情请求（80 组实测详情请求从约 90 次降到 1 次），
//      年份以详情返回的专辑 ID 为准入 albumYearCache，本来就在歌单里的专辑直接命中缓存。
async function correctSongList(list) {
  const keyOf = (s) => `${cleanTitle(s.name)}|${normName(s.artist.split(' / ')[0])}`;
  for (const s of list) if (s.albumId && s.year) albumYearCache.set(s.albumId, s.year);
  // 疑似判定有两种：①歌名/专辑名带重制、再版、精选等关键词；
  // ②同一批歌里已有同名同歌手的更早版本（早 3 年以上）——这首多半来自精选集或再版，
  //   即使专辑名不带任何关键词（如精选集《Warheads On Foreheads》）也能抓到。
  const byKey = new Map();
  const internalEarliest = new Map();
  for (const s of list) {
    if (!s.year) continue;
    const key = keyOf(s);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(s);
    if (!internalEarliest.has(key) || s.year < internalEarliest.get(key)) internalEarliest.set(key, s.year);
  }
  const groups = new Map();
  for (const s of list) {
    if (!s.year) continue;
    const key = keyOf(s);
    const suspect = isFlagged(s.name, s.album) || internalEarliest.get(key) <= s.year - 3;
    if (!suspect) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const flagged = [...groups.values()].reduce((a, g) => a + g.length, 0);
  let corrected = 0;
  const examples = [];
  const applyEarliest = (songs, earliest) => {
    if (!earliest) return;
    for (const s of songs) {
      if (earliest <= s.year - 3) {
        if (examples.length < 5) examples.push(`${s.name}（${s.year} → ${earliest}）`);
        s.year = earliest;
        corrected++;
      }
    }
  };
  // 0) 内部直判
  const searchGroups = [];
  for (const [key, songs] of groups) {
    const e = internalEarliest.get(key);
    const earliestCopies = (byKey.get(key) || []).filter((x) => x.year === e);
    const direct = songs.every((s) => e <= s.year - 3) && !earliestCopies.some((x) => isFlagged(x.name, x.album));
    if (direct) applyEarliest(songs, e);
    else if (originalYearCache.has(key)) applyEarliest(songs, originalYearCache.get(key));
    else searchGroups.push([key, songs]);
  }
  if (searchGroups.length) {
    // 1) 8 路并发搜索
    const candByKey = new Map();
    const failedKeys = new Set();
    let nextIdx = 0;
    let doneCount = 0;
    const worker = async () => {
      while (nextIdx < searchGroups.length) {
        const [key, songs] = searchGroups[nextIdx++];
        try { candByKey.set(key, await searchCandidates(songs[0].name, songs[0].artist.split(' / ')[0])); }
        catch (e) { candByKey.set(key, []); failedKeys.add(key); }
        doneCount++;
        if (doneCount % 50 === 0 || doneCount === searchGroups.length) {
          console.log(`  校正进度 搜索 ${doneCount}/${searchGroups.length} 组`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, searchGroups.length) }, worker));
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
        const sd = await callApi(() => api.song_detail({ ids: batch.map(([, id]) => id).join(','), ...BASE }), '原版年份详情', 3, 30000);
        for (const s of sd.body.songs || []) {
          const ts = (s.al && s.al.publishTime) || s.publishTime;
          if (!ts) continue;
          const y = new Date(ts).getFullYear();
          if (y < 1900 || y > CURRENT_YEAR) continue;
          songYearById.set(s.id, y);
          if (s.al && s.al.id) albumYearCache.set(s.al.id, y);
        }
      } catch (e) { /* 这一批失败，对应组按查不到处理 */ }
    }
    // 3) 汇总应用
    for (const [key, songs] of searchGroups) {
      const cands = candByKey.get(key) || [];
      let earliest = null;
      for (const c of cands) {
        const y = songYearById.get(c.id) ?? (c.albumId ? albumYearCache.get(c.albumId) : null);
        if (y && (!earliest || y < earliest)) earliest = y;
      }
      if (!failedKeys.has(key)) originalYearCache.set(key, earliest);
      applyEarliest(songs, earliest);
    }
  }
  return { corrected, examples, flagged };
}

// 取一个歌单的全量 trackIds（不足时用 track/all 分页补齐）
async function getFullTrackIds(playlist) {
  const pd = await callApi(() => api.playlist_detail({ id: playlist.id, ...BASE }), '歌单详情查询');
  let trackIds = (pd.body.playlist.trackIds || []).map((t) => t.id);
  if (trackIds.length < playlist.trackCount) {
    const seen = new Set(trackIds);
    for (let offset = 0; offset < playlist.trackCount; offset += 1000) {
      const ta = await callApi(() => api.playlist_track_all({ id: playlist.id, limit: 1000, offset, ...BASE }), '歌单分页查询');
      for (const s of ta.body.songs || []) if (!seen.has(s.id)) { seen.add(s.id); trackIds.push(s.id); }
      if ((ta.body.songs || []).length === 0) break;
      await sleep(300);
    }
  }
  return trackIds;
}

// ---- QQ 音乐（网页端公开只读接口，匿名；与 server.js 同一套端点）----
const QQ_HEADERS = { Referer: 'https://y.qq.com/', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
const QQ_QS = 'g_tk=5381&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0';
const qqYearCache = new Map();
function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}
async function qqCall(url, label) {
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { headers: QQ_HEADERS });
      const d = JSON.parse(await r.text());
      if (d.code !== 0) throw new Error(`code=${d.code}`);
      return d;
    } catch (e) { lastErr = e; if (attempt < 3) await sleep(attempt * 1000); }
  }
  throw new Error(`${label}失败：${lastErr.message}`);
}
async function qqAlbumYear(mid) {
  if (qqYearCache.has(mid)) return qqYearCache.get(mid);
  let year = null;
  try {
    const d = await qqCall(`https://c.y.qq.com/v8/fcg-bin/fcg_v8_album_info_cp.fcg?albummid=${encodeURIComponent(mid)}&${QQ_QS}`, 'QQ专辑查询');
    const m = /^(\d{4})/.exec((d.data && d.data.aDate) || '');
    if (m) { const y = Number(m[1]); if (y >= 1900 && y <= CURRENT_YEAR) year = y; }
  } catch (e) { /* 查不到按无年份 */ }
  qqYearCache.set(mid, year);
  return year;
}
async function mainQQ(input, optList) {
  const s = String(input || '').trim();
  let playlistId = null;
  let uin = null;
  let m = s.match(/playlist\/(\d+)/) || s.match(/[?&](?:disstid|id)=(\d+)/);
  if (m && /qq\.com/.test(s)) playlistId = m[1];
  else if ((m = s.match(/profile\/([\w*+=-]+)/))) uin = decodeURIComponent(m[1]);
  else if (/^\d{5,11}$/.test(s) || /^[\w*=-]{8,64}$/.test(s)) uin = s;
  if (!playlistId && !uin) throw new Error('无法识别输入：请给 QQ 号、QQ 音乐主页链接或歌单链接。');

  let nickname = 'QQ 音乐歌单';
  let playlists = [];
  if (playlistId) {
    const d = await qqCall(`https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?type=1&json=1&utf8=1&onlysong=0&disstid=${playlistId}&${QQ_QS}`, 'QQ歌单查询');
    const cd = (d.cdlist || [])[0];
    if (!cd) throw new Error('歌单不存在或未公开。');
    playlists = [{ id: playlistId, name: decodeEntities(cd.dissname), trackCount: (cd.songlist || []).length, _songs: cd.songlist }];
  } else {
    const all = [];
    for (let sin = 0; ; sin += 100) {
      const d = await qqCall(`https://c.y.qq.com/rsc/fcgi-bin/fcg_user_created_diss?hostuin=${encodeURIComponent(uin)}&sin=${sin}&size=100&${QQ_QS}`, 'QQ歌单列表查询');
      const data = d.data || {};
      if (data.hostname) nickname = decodeEntities(data.hostname);
      const list = data.disslist || [];
      all.push(...list);
      if (!list.length || (data.totoal && all.length >= data.totoal)) break;
    }
    playlists = all.filter((p) => p.tid && Number(p.tid) > 0)
      .map((p) => ({ id: String(p.tid), name: decodeEntities(p.diss_name), trackCount: p.song_cnt || 0 }));
    console.log(`用户：${nickname}（QQ 音乐）`);
    if (!playlists.length) throw new Error('没有找到公开的自建歌单（主页未公开，或只有「我喜欢」——QQ 的「我喜欢」需登录才能读）。');
  }
  if (optList) {
    console.log(`公开自建歌单（共 ${playlists.length} 个）：`);
    playlists.forEach((p) => console.log(`  - ${p.name}｜${p.trackCount} 首｜ID ${p.id}`));
    return;
  }
  console.log('计入的歌单：');
  playlists.forEach((p) => console.log(`  - ${p.name}（${p.trackCount} 首）`));
  const byId = new Map();
  let rawTotal = 0;
  const fetched = await mapPool(playlists, 4, async (p) => {
    if (p._songs) return p._songs;
    const d = await qqCall(`https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?type=1&json=1&utf8=1&onlysong=0&disstid=${p.id}&${QQ_QS}`, 'QQ歌单查询');
    return ((d.cdlist || [])[0] || {}).songlist || [];
  });
  for (const list of fetched) {
    rawTotal += list.length;
    for (const s of list) {
      const id = s.songmid || String(s.songid || '');
      if (id && !byId.has(id)) {
        byId.set(id, {
          name: decodeEntities(s.songname),
          artist: (s.singer || []).map((a) => decodeEntities(a.name)).join(' / '),
          album: decodeEntities(s.albumname),
          albummid: s.albummid || '',
        });
      }
    }
  }
  const merged = [...byId.values()];
  const mids = [...new Set(merged.map((x) => x.albummid).filter(Boolean))];
  console.log(`原始合计 ${rawTotal} 首，去重后 ${merged.length} 首，正在按 ${mids.length} 张专辑补发行年份…`);
  await mapPool(mids, 6, (mid) => qqAlbumYear(mid));
  const songs = [];
  let noYear = 0;
  for (const x of merged) {
    const year = x.albummid ? qqYearCache.get(x.albummid) : null;
    if (year) songs.push({ ...x, year, age: CURRENT_YEAR - year + 17 });
    else noYear++;
  }
  if (!songs.length) throw new Error('没有查到任何歌曲的发行年份，无法计算。');
  const avg = songs.reduce((a, x) => a + x.age, 0) / songs.length;
  const musicAge = Math.round(avg);
  const sortedAges = songs.map((x) => x.age).sort((a, b) => a - b);
  const mid = Math.floor(sortedAges.length / 2);
  const medianAge = sortedAges.length % 2 ? sortedAges[mid] : Math.round((sortedAges[mid - 1] + sortedAges[mid]) / 2);
  const byYear = [...songs].sort((a, b) => a.year - b.year);
  const decades = {};
  for (const x of songs) { const d = Math.floor(x.year / 10) * 10; decades[d] = (decades[d] || 0) + 1; }
  const artistCount = {};
  for (const x of songs) for (const a of x.artist.split(' / ')) if (a) artistCount[a] = (artistCount[a] || 0) + 1;
  const topArtists = Object.entries(artistCount).sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log('\n========== 结果（QQ 音乐）==========');
  console.log(`${nickname} 的音乐年龄是 ${musicAge} 岁（= ${generationLabel(musicAge)}）`);
  console.log(`中位数音乐年龄 ${medianAge} 岁`);
  console.log(`参与计算 ${songs.length} 首（去重后共 ${merged.length} 首，另有 ${noYear} 首缺发行年份未计入）`);
  console.log(`最老的歌：${byYear[0].name} — ${byYear[0].artist}（${byYear[0].year} 年，单曲音乐年龄 ${byYear[0].age} 岁）`);
  console.log(`最新的歌：${byYear[byYear.length - 1].name} — ${byYear[byYear.length - 1].artist}（${byYear[byYear.length - 1].year} 年）`);
  console.log('年代分布：', Object.entries(decades).sort((a, b) => a[0] - b[0]).map(([d, c]) => `${d}年代 ${c} 首`).join('、'));
  console.log('最爱歌手 Top5：', topArtists.map(([a, c]) => `${a}（${c} 首）`).join('、'));
  const outDir = path.join(__dirname, 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const tag = playlistId ? `pl${playlistId}` : String(uin).replace(/[^\w]/g, '');
  fs.writeFileSync(path.join(outDir, `music-age-qq-${tag}.json`), JSON.stringify({ platform: 'qq', nickname, playlists: playlists.map((p) => ({ id: p.id, name: p.name, trackCount: p.trackCount })), rawTotal, uniqueTotal: merged.length, counted: songs.length, noYear, musicAge, avgAge: +avg.toFixed(1), medianAge, label: generationLabel(musicAge), generatedAt: new Date().toISOString() }, null, 2));
  console.log(`\n结果 JSON 已生成：${path.join(outDir, `music-age-qq-${tag}.json`)}`);
}

// ---- 酷我音乐（列单走老服务 getuserlist，取歌走 www playListInfo，逐曲自带 releaseDate）----
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
let kuwoTk = null;
async function kuwoToken(force) {
  if (!force && kuwoTk) return kuwoTk;
  const r = await fetch('https://www.kuwo.cn/', { headers: { 'User-Agent': QQ_HEADERS['User-Agent'] } });
  const pairs = (typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : []).map((sc) => sc.split(';')[0].trim()).filter(Boolean);
  const tp = pairs.find((p) => /^Hm_Iuvt_[^=]+=/.test(p));
  if (!tp) throw new Error('没有拿到酷我令牌 cookie');
  const eq = tp.indexOf('=');
  const name = tp.slice(0, eq);
  const value = decodeURIComponent(tp.slice(eq + 1));
  kuwoTk = { cookie: pairs.join('; '), csrf: value, secret: kuwoH(value, name) };
  return kuwoTk;
}
async function kuwoWww(pathQ) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const tk = await kuwoToken(attempt === 1);
    const r = await fetch('https://www.kuwo.cn' + pathQ, { headers: { 'User-Agent': QQ_HEADERS['User-Agent'], Referer: 'https://www.kuwo.cn/', Cookie: tk.cookie, csrf: tk.csrf, Secret: tk.secret } });
    const d = JSON.parse(await r.text());
    if (d && (d.code === 200 || d.success)) return d;
    if (attempt === 1) throw new Error(`酷我接口被拒绝（${(d && d.message) || '未知原因'}）`);
  }
  throw new Error('酷我接口失败');
}
async function kuwoPlaylistSongs(pid) {
  const songs = [];
  let name = '';
  let total = Infinity;
  for (let pn = 1; songs.length < total; pn++) {
    const d = await kuwoWww(`/api/www/playlist/playListInfo?pid=${pid}&pn=${pn}&rn=100&httpsStatus=1&reqId=${require('crypto').randomUUID()}`);
    const data = d.data || {};
    if (data.name) name = data.name;
    total = data.total || 0;
    const list = data.musicList || [];
    if (!list.length) break;
    for (const t of list) {
      const y = t.releaseDate === '1970-01-01' ? null : /^(\d{4})/.exec(t.releaseDate || ''); // 1970-01-01 是酷我的「日期未知」哨兵值
      songs.push({ id: String(t.rid != null ? t.rid : ''), name: t.name || '', artist: t.artist || '', album: t.album || '', year: y ? Number(y[1]) : null });
    }
    if (list.length < 100) break;
  }
  return { name, songs };
}
async function mainKuwo(input, optList) {
  const s = String(input || '').trim();
  let m = s.match(/playlist_detail\/(\d+)/) || s.match(/[?&]pid=(\d+)/);
  let nickname = '酷我音乐歌单';
  let playlists = [];
  if (m) {
    playlists = [{ id: m[1], name: '', trackCount: 0, kind: 'own', _pid: m[1] }];
  } else if (/^\d{3,15}$/.test(s)) {
    const all = [];
    for (let pn = 0; ; pn++) {
      const r = await fetch(`https://nplserver.kuwo.cn/pl.svc?op=getuserlist&uid=${s}&userid=${s}&pn=${pn}&rn=200&encode=utf8&keyset=pl2012&identity=kuwo&pcmp4=1&vipver=MUSIC_9.0.5.0_W1&newver=1`, { headers: { 'User-Agent': QQ_HEADERS['User-Agent'] } });
      const dd = JSON.parse(await r.text());
      const plist = dd.plist || [];
      all.push(...plist);
      if (!plist.length || all.length >= (dd.total || 0)) break;
    }
    playlists = all.filter((p) => (p.type === 'MYFAVORITE' || p.type === 'GENERAL') && p.ispub && !p.hidden)
      .map((p) => ({ id: String(p.id), name: p.title || (p.type === 'MYFAVORITE' ? '我喜欢听' : '未命名歌单'), trackCount: p.musicnum || 0, kind: p.type === 'MYFAVORITE' ? 'liked' : 'own', _pid: String(p.id) }));
    nickname = '酷我用户 ' + s;
    if (!playlists.length) throw new Error('没有找到公开的歌单（对方未公开自建歌单或「我喜欢听」）。');
    console.log(`用户：${nickname}（酷我音乐）`);
  } else {
    throw new Error('无法识别输入：请给酷我用户 ID（纯数字）或酷我歌单链接。');
  }
  if (optList) {
    console.log(`公开歌单（共 ${playlists.length} 个）：`);
    playlists.forEach((p) => console.log(`  - ${p.name}｜${p.kind === 'liked' ? '我喜欢听' : '自建'}｜${p.trackCount} 首｜ID ${p.id}`));
    return;
  }
  const byId = new Map();
  let rawTotal = 0;
  const fetched = await mapPool(playlists, 4, async (p) => kuwoPlaylistSongs(p._pid));
  for (const d of fetched) {
    rawTotal += d.songs.length;
    for (const x of d.songs) if (x.id && !byId.has(x.id)) byId.set(x.id, x);
  }
  const merged = [...byId.values()];
  const songs = [];
  let noYear = 0;
  for (const x of merged) {
    if (x.year) songs.push({ ...x, age: CURRENT_YEAR - x.year + 17 });
    else noYear++;
  }
  if (!songs.length) throw new Error('没有取到任何带发行年份的歌曲，无法计算。');
  const avg = songs.reduce((a, x) => a + x.age, 0) / songs.length;
  const musicAge = Math.round(avg);
  const sortedAges = songs.map((x) => x.age).sort((a, b) => a - b);
  const mid = Math.floor(sortedAges.length / 2);
  const medianAge = sortedAges.length % 2 ? sortedAges[mid] : Math.round((sortedAges[mid - 1] + sortedAges[mid]) / 2);
  const byYear = [...songs].sort((a, b) => a.year - b.year);
  const decades = {};
  for (const x of songs) { const d = Math.floor(x.year / 10) * 10; decades[d] = (decades[d] || 0) + 1; }
  const artistCount = {};
  for (const x of songs) for (const a of x.artist.split(' / ')) if (a) artistCount[a] = (artistCount[a] || 0) + 1;
  const topArtists = Object.entries(artistCount).sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log('\n========== 结果（酷我音乐）==========');
  console.log(`${nickname} 的音乐年龄是 ${musicAge} 岁（= ${generationLabel(musicAge)}）`);
  console.log(`中位数音乐年龄 ${medianAge} 岁`);
  console.log(`参与计算 ${songs.length} 首（去重后共 ${merged.length} 首，原始合计 ${rawTotal} 首，另有 ${noYear} 首缺发行年份未计入）`);
  console.log(`最老的歌：${byYear[0].name} — ${byYear[0].artist}（${byYear[0].year} 年，单曲音乐年龄 ${byYear[0].age} 岁）`);
  console.log(`最新的歌：${byYear[byYear.length - 1].name} — ${byYear[byYear.length - 1].artist}（${byYear[byYear.length - 1].year} 年）`);
  console.log('年代分布：', Object.entries(decades).sort((a, b) => a[0] - b[0]).map(([d, c]) => `${d}年代 ${c} 首`).join('、'));
  console.log('最爱歌手 Top5：', topArtists.map(([a, c]) => `${a}（${c} 首）`).join('、'));
}

async function main() {
  const argv = process.argv.slice(2);
  const kwIdx = argv.indexOf('--kuwo');
  if (kwIdx >= 0) {
    const input = argv[kwIdx + 1];
    if (!input) { console.error('用法: node music-age.js --kuwo <酷我用户ID|歌单链接> [--list]'); process.exit(2); }
    await mainKuwo(input, argv.includes('--list'));
    return;
  }
  const qqIdx = argv.indexOf('--qq');
  if (qqIdx >= 0) {
    const input = argv[qqIdx + 1];
    if (!input) { console.error('用法: node music-age.js --qq <QQ号|QQ音乐主页链接|歌单链接> [--list]'); process.exit(2); }
    await mainQQ(input, argv.includes('--list'));
    return;
  }
  const input = process.argv[2];
  const flags = process.argv.slice(3);
  if (!input) { console.error('用法: node music-age.js <网易云主页链接|用户ID> [--all | --ids=<id1,id2> | --list]；QQ 音乐用 --qq'); process.exit(2); }
  const optAll = flags.includes('--all');
  const optList = flags.includes('--list');
  const idsFlag = flags.find((f) => f.startsWith('--ids='));
  const optIds = idsFlag ? new Set(idsFlag.slice(6).split(',').map((x) => Number(x.trim())).filter(Boolean)) : null;

  const uid = await resolveUid(input);
  const ud = await callApi(() => api.user_detail({ uid, ...BASE }), '用户信息查询');
  const profile = ud.body.profile;
  console.log(`用户：${profile.nickname}（ID ${uid}，Lv.${ud.body.level}）`);

  // 分页取全部公开歌单（每波并发 3 页，歌单多的用户不用逐页等）
  const playlists = [];
  let waveStart = 0;
  let pageDone = false;
  while (!pageDone) {
    const pages = await Promise.all([waveStart, waveStart + 100, waveStart + 200].map((offset) =>
      callApi(() => api.user_playlist({ uid, limit: 100, offset, ...BASE }), '歌单列表查询')));
    for (const up of pages) {
      const list = up.body.playlist || [];
      playlists.push(...list);
      if (!up.body.more || !list.length) { pageDone = true; break; }
    }
    waveStart += 300;
  }
  if (!playlists.length) throw new Error('没有找到任何公开歌单。可能对方把歌单都设为了隐私，请在网易云 App 里把歌单设为公开后重试。');
  for (const p of playlists) p.kind = kindOf(p, uid);

  if (optList) {
    console.log(`\n全部公开歌单（共 ${playlists.length} 个）：`);
    playlists.forEach((p, i) => console.log(`  [${i}] ${p.name}｜${KIND_LABEL[p.kind]}${p.kind === 'subscribed' && p.creator ? `（创建者：${p.creator.nickname}）` : ''}｜${p.trackCount} 首｜ID ${p.id}`));
    console.log('\n用 --ids=<歌单ID1,歌单ID2> 选择要计算的歌单，或 --all 计算喜欢+全部自建歌单。');
    return;
  }

  // 选择歌单
  let selected;
  if (optIds) selected = playlists.filter((p) => optIds.has(p.id));
  else if (optAll) selected = playlists.filter((p) => p.kind === 'liked' || p.kind === 'own');
  else selected = playlists.filter((p) => p.kind === 'liked');
  if (!selected.length) {
    throw new Error(optIds
      ? '指定的歌单 ID 没有匹配到任何公开歌单，先用 --list 查看。'
      : '没有找到符合条件的公开歌单（默认只算「我喜欢的音乐」，可用 --all 或 --ids 选择其他歌单，先用 --list 查看）。');
  }
  console.log('计入的歌单：');
  selected.forEach((p) => console.log(`  - ${p.name}（${KIND_LABEL[p.kind]}，${p.trackCount} 首）`));

  // 聚合 trackIds 并跨歌单去重（4 个歌单并发拉，歌单多的用户不用干等；单个歌单失败跳过并注明）
  const idSet = new Set();
  let rawTotal = 0;
  const allIds = await mapPool(selected, 4, async (p) => {
    try { return await getFullTrackIds(p); }
    catch (e) { console.log(`  歌单「${p.name}」读取失败，已跳过（${(e.body && e.body.msg) || e.message}）`); return []; }
  });
  for (const ids of allIds) {
    rawTotal += ids.length;
    for (const id of ids) idSet.add(id);
  }
  const trackIds = [...idSet];
  console.log(`原始合计 ${rawTotal} 首，去重后 ${trackIds.length} 首，开始批量查询发行年份…`);

  // 分批取歌曲详情 -> 专辑发行年份
  const songs = [];
  let noYear = 0;
  for (let i = 0; i < trackIds.length; i += BATCH) {
    const batch = trackIds.slice(i, i + BATCH);
    const sd = await callApi(() => api.song_detail({ ids: batch.join(','), ...BASE }), '歌曲详情查询');
    for (const s of sd.body.songs || []) {
      const ts = (s.al && s.al.publishTime) || s.publishTime;
      const year = ts ? new Date(ts).getFullYear() : null;
      const artist = (s.ar || []).map((a) => a.name).join(' / ');
      if (year && year >= 1900 && year <= CURRENT_YEAR) {
        songs.push({ name: s.name, artist, album: s.al ? s.al.name : '', albumId: s.al ? s.al.id : 0, year, age: CURRENT_YEAR - year + 17 });
      } else noYear++;
    }
    process.stdout.write(`  进度 ${Math.min(i + BATCH, trackIds.length)}/${trackIds.length}\n`);
    await sleep(300);
  }
  if (!songs.length) throw new Error('没有取到任何带发行年份的歌曲，无法计算。');

  // 校正重制/再版/精选专辑歌曲的年份（专辑年份晚于原版年份会把结果算小）
  const ageBeforeCorrection = Math.round(songs.reduce((a, s) => a + s.age, 0) / songs.length);
  console.log('正在检测重制/再版/精选专辑歌曲并查原版年份校正…');
  const correction = await correctSongList(songs);
  const flaggedCount = correction.flagged || 0;
  if (flaggedCount) {
    for (const s of songs) s.age = CURRENT_YEAR - s.year + 17;
    console.log(`检测到 ${flaggedCount} 首疑似歌曲，已校正 ${correction.corrected} 首${correction.examples.length ? '，例如：' + correction.examples.join('；') : ''}`);
  } else {
    console.log('没有检测到疑似重制/再版/精选专辑歌曲');
  }

  // 统计
  const avg = songs.reduce((a, s) => a + s.age, 0) / songs.length;
  const musicAge = Math.round(avg);
  // 中位数音乐年龄：平均值容易被极端值拉动（一首 1936 年的歌单曲年龄 107 岁），中位数几乎不受影响，一起看更真实
  const sortedAges = songs.map((s) => s.age).sort((a, b) => a - b);
  const mid = Math.floor(sortedAges.length / 2);
  const medianAge = sortedAges.length % 2 ? sortedAges[mid] : Math.round((sortedAges[mid - 1] + sortedAges[mid]) / 2);
  const sortedByYear = [...songs].sort((a, b) => a.year - b.year);
  const oldest = sortedByYear[0];
  const newest = sortedByYear[sortedByYear.length - 1];
  const decades = {};
  for (const s of songs) {
    const d = Math.floor(s.year / 10) * 10;
    decades[d] = (decades[d] || 0) + 1;
  }
  const artistCount = {};
  for (const s of songs) for (const a of s.artist.split(' / ')) if (a) artistCount[a] = (artistCount[a] || 0) + 1;
  const topArtists = Object.entries(artistCount).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const playlistLabel = selected.length === 1 ? selected[0].name : `${selected.length} 个歌单`;

  // 听歌排行视角：历史播放最高 100 首 + 最近一周（对方未公开排行时跳过，不影响主结果）
  let recordPanels = null;
  try {
    const fetchChart = async (type) => {
      const r = await callApi(() => api.user_record({ uid, type, ...BASE }), '听歌排行查询');
      const list = (type === 1 ? r.body.weekData : r.body.allData) || [];
      return list.map((it) => it.song.id);
    };
    const weekIds = await fetchChart(1);
    const topIds = await fetchChart(0);
    if (weekIds.length || topIds.length) {
      const union = [...new Set([...weekIds, ...topIds])];
      const metaById = new Map();
      for (let i = 0; i < union.length; i += BATCH) {
        const sd = await callApi(() => api.song_detail({ ids: union.slice(i, i + BATCH).join(','), ...BASE }), '排行歌曲详情查询');
        for (const s of sd.body.songs || []) {
          const ts = (s.al && s.al.publishTime) || s.publishTime;
          const y = ts ? new Date(ts).getFullYear() : null;
          if (y && y >= 1900 && y <= CURRENT_YEAR) {
            metaById.set(s.id, { name: s.name, artist: (s.ar || []).map((a) => a.name).join(' / '), album: s.al ? s.al.name : '', albumId: s.al ? s.al.id : 0, year: y });
          }
        }
        await sleep(200);
      }
      await correctSongList([...metaById.values()]);
      const panel = (ids) => {
        const ys = ids.map((id) => { const m = metaById.get(id); return m ? m.year : null; }).filter(Boolean);
        if (!ys.length) return null;
        return { age: Math.round(ys.reduce((a, y) => a + (CURRENT_YEAR - y + 17), 0) / ys.length), counted: ys.length, total: ids.length };
      };
      recordPanels = { week: panel(weekIds), top: panel(topIds) };
    }
  } catch (e) { recordPanels = null; }
  const deltaText = (panelAge) => {
    const d = panelAge - musicAge;
    return d <= -2 ? `比歌单年龄年轻 ${-d} 岁` : d >= 2 ? `比歌单年龄老 ${d} 岁` : '和歌单年龄差不多';
  };

  const result = {
    nickname: profile.nickname, uid,
    playlists: selected.map((p) => ({ id: p.id, name: p.name, kind: p.kind, trackCount: p.trackCount })),
    rawTotal, uniqueTotal: trackIds.length,
    counted: songs.length, noYear,
    musicAge, avgAge: +avg.toFixed(1), medianAge, label: generationLabel(musicAge),
    oldest, newest, decades, topArtists,
    records: recordPanels,
    correction: { flagged: flaggedCount, corrected: correction.corrected, ageBeforeCorrection },
    generatedAt: new Date().toISOString(),
  };

  console.log('\n========== 结果 ==========');
  console.log(`${profile.nickname} 的音乐年龄是 ${musicAge} 岁（= ${result.label}）`);
  console.log(`中位数音乐年龄 ${medianAge} 岁（一半的歌比它老、一半比它新；与平均值差得越多，极端老歌/新歌的影响越大）`);
  console.log(`参与计算 ${songs.length} 首（去重后共 ${trackIds.length} 首，另有 ${noYear} 首缺发行年份未计入）`);
  if (correction.corrected) console.log(`其中 ${correction.corrected} 首重制/再版/精选专辑歌曲已按原版发行年份校正（不校正会算成 ${ageBeforeCorrection} 岁）`);
  console.log(`最老的歌：${oldest.name} — ${oldest.artist}（${oldest.year} 年，单曲音乐年龄 ${oldest.age} 岁）`);
  console.log(`最新的歌：${newest.name} — ${newest.artist}（${newest.year} 年）`);
  console.log('年代分布：', Object.entries(decades).sort((a, b) => a[0] - b[0]).map(([d, c]) => `${d}年代 ${c} 首`).join('、'));
  console.log('最爱年代歌手 Top5：', topArtists.map(([a, c]) => `${a}（${c} 首）`).join('、'));
  if (recordPanels) {
    console.log('\n----- 听歌排行视角 -----');
    if (recordPanels.top) console.log(`历史最爱（播放最高 100 首）：${recordPanels.top.age} 岁（按 ${recordPanels.top.counted} 首计，${deltaText(recordPanels.top.age)}）`);
    if (recordPanels.week) {
      console.log(`最近一周在听：${recordPanels.week.age} 岁（按 ${recordPanels.week.counted} 首计，${deltaText(recordPanels.week.age)}）`);
      const d = recordPanels.week.age - musicAge;
      console.log(d <= -2 ? '结论：最近实际在听的歌比歌单更年轻，音乐年龄在变年轻。' : d >= 2 ? '结论：最近实际在听的歌比歌单更老，音乐年龄在变老。' : '结论：最近实际在听的歌和歌单品味基本一致，音乐年龄稳定。');
    }
  } else {
    console.log('\n（听歌排行未公开或为空，排行视角跳过）');
  }

  // HTML 结果卡
  const outDir = path.join(__dirname, 'output');
  fs.mkdirSync(outDir, { recursive: true });
  const decadeRows = Object.entries(decades).sort((a, b) => a[0] - b[0])
    .map(([d, c]) => `<div class="row"><span>${d}年代</span><div class="bar" style="width:${Math.round((c / songs.length) * 100)}%"></div><span>${c} 首</span></div>`).join('');
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${profile.nickname} 的音乐年龄</title>
<style>body{font-family:system-ui,"PingFang SC","Microsoft YaHei",sans-serif;background:#f6f6f8;margin:0;padding:24px;color:#222}
.card{max-width:560px;margin:0 auto;background:#fff;border-radius:16px;padding:28px;box-shadow:0 4px 24px rgba(0,0,0,.08)}
h1{font-size:20px;margin:0 0 4px}.sub{color:#888;font-size:13px;margin-bottom:16px}
.age{font-size:56px;font-weight:800;color:#d33;text-align:center;margin:12px 0 0}
.label{text-align:center;font-size:16px;margin:4px 0 16px}
.grid{display:flex;gap:12px;margin:16px 0}.box{flex:1;background:#fafafa;border-radius:10px;padding:10px 12px;font-size:13px}
.row{display:flex;align-items:center;gap:8px;font-size:13px;margin:4px 0}.row span:first-child{width:52px}.bar{height:10px;background:#d33;border-radius:5px;min-width:2px}
.foot{color:#999;font-size:12px;margin-top:16px;line-height:1.6}</style></head><body><div class="card">
<h1>${profile.nickname} 的音乐年龄</h1><div class="sub">来自${playlistLabel}，去重后 ${trackIds.length} 首，${songs.length} 首参与计算</div>
<div class="age">${musicAge} 岁</div><div class="label">= ${result.label}</div>
<div style="text-align:center;color:#888;font-size:13px;margin-bottom:8px">中位数音乐年龄 ${medianAge} 岁（平均 ${result.avgAge} 岁）</div>
<div class="grid"><div class="box">最老的歌<br><b>${oldest.name}</b><br>${oldest.artist} · ${oldest.year} 年</div>
<div class="box">最新的歌<br><b>${newest.name}</b><br>${newest.artist} · ${newest.year} 年</div></div>
<h3 style="margin:12px 0 6px">年代分布</h3>${decadeRows}
<h3 style="margin:14px 0 6px">歌单里最多的歌手</h3><div style="font-size:14px">${topArtists.map(([a, c]) => `${a}（${c} 首）`).join('、')}</div>
${recordPanels ? `<h3 style="margin:14px 0 6px">听歌排行视角</h3><div style="font-size:14px">${[recordPanels.top ? `历史最爱（播放最高 100 首）：<b>${recordPanels.top.age} 岁</b>（${deltaText(recordPanels.top.age)}）` : '', recordPanels.week ? `最近一周在听：<b>${recordPanels.week.age} 岁</b>（${deltaText(recordPanels.week.age)}）` : ''].filter(Boolean).join('<br>')}</div>` : ''}
<div class="foot">计入歌单：${selected.map((p) => p.name).join('、')}。算法：假设每首歌都是在发行那年 17 岁时听的，单曲音乐年龄 = ${CURRENT_YEAR} − 发行年份 + 17，取全部平均（四舍五入）；同一首歌在多个歌单出现只算一次。另有 ${noYear} 首缺发行年份未计入。${correction.corrected ? `其中 ${correction.corrected} 首来自重制/再版/精选专辑，已按原版发行年份校正（不校正会算成 ${ageBeforeCorrection} 岁）。` : ''}作为参照，日本原站「音楽数珠つなぎ」公布的用户平均音乐年龄为 28 岁。数据来自网易云公开接口（NeteaseCloudMusicApi）。</div>
</div></body></html>`;
  const file = path.join(outDir, `music-age-${uid}.html`);
  fs.writeFileSync(file, html);
  fs.writeFileSync(path.join(outDir, `music-age-${uid}.json`), JSON.stringify(result, null, 2));
  console.log(`\n结果卡已生成：${file}`);
}

main().catch((e) => { console.error('失败：', errText(e)); process.exit(1); });
