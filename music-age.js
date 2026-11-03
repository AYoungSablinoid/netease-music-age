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
 */
const fs = require('fs');
const path = require('path');
const api = require('NeteaseCloudMusicApi');

const PROXY = process.env.https_proxy || process.env.HTTPS_PROXY || '';
const BASE = { proxy: PROXY, realIP: true };
const CURRENT_YEAR = new Date().getFullYear();
const BATCH = 500;

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
async function callApi(fn, label, attempts = 4) {
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await fn(); } catch (e) {
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

const originalYearCache = new Map();
async function findOriginalYear(name, artist) {
  const base = cleanTitle(name);
  if (!base || !artist) return null;
  const key = `${base}|${normName(artist)}`;
  if (originalYearCache.has(key)) return originalYearCache.get(key);
  let earliest = null;
  let failed = false;
  try {
    // 校正搜索只重试 3 次：失败只是少校正一首，不值得拖慢整体
    const r = await callApi(() => api.cloudsearch({ keywords: `${base} ${artist}`, type: 1, limit: 30, ...BASE }), '原版年份搜索', 3);
    const found = ((r.body.result && r.body.result.songs) || [])
      .filter((s) => cleanTitle(s.name) === base && (s.ar || []).some((a) => normName(a.name) === normName(artist)));
    if (found.length) {
      const sd = await callApi(() => api.song_detail({ ids: found.map((s) => s.id).join(','), ...BASE }), '原版年份详情', 3);
      for (const s of sd.body.songs || []) {
        const ts = (s.al && s.al.publishTime) || s.publishTime;
        if (ts) {
          const y = new Date(ts).getFullYear();
          if (y >= 1900 && y <= CURRENT_YEAR && (!earliest || y < earliest)) earliest = y;
        }
      }
    }
  } catch (e) { earliest = null; failed = true; }
  if (!failed) originalYearCache.set(key, earliest);
  return earliest;
}

// 只校正「最早版本比当前计入年份早 3 年以上」的情况，过滤掉一两年的噪声。原地改 year。
// 先按「清洗后歌名+主歌手」分组去重（同一首歌在多个歌单重复出现只搜一次），再 5 路并发搜索：
// 逐首串行时几百首疑似歌曲要几十分钟，并发+去重后快数倍。
async function correctSongList(list) {
  // 疑似判定有两种：①歌名/专辑名带重制、再版、精选等关键词；
  // ②同一批歌里已有同名同歌手的更早版本（早 3 年以上）——这首多半来自精选集或再版，
  //   即使专辑名不带任何关键词（如精选集《Warheads On Foreheads》）也能抓到。
  const internalEarliest = new Map();
  for (const s of list) {
    if (!s.year) continue;
    const key = `${cleanTitle(s.name)}|${normName(s.artist.split(' / ')[0])}`;
    if (!internalEarliest.has(key) || s.year < internalEarliest.get(key)) internalEarliest.set(key, s.year);
  }
  const groups = new Map();
  for (const s of list) {
    if (!s.year) continue;
    const key = `${cleanTitle(s.name)}|${normName(s.artist.split(' / ')[0])}`;
    const suspect = isFlagged(s.name, s.album) || internalEarliest.get(key) <= s.year - 3;
    if (!suspect) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const entries = [...groups.values()];
  let corrected = 0;
  const examples = [];
  const CONCURRENCY = 5;
  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const chunk = entries.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(async (songs) => {
      const rep = songs[0];
      const earliest = await findOriginalYear(rep.name, rep.artist.split(' / ')[0]);
      if (!earliest) return;
      for (const s of songs) {
        if (earliest <= s.year - 3) {
          if (examples.length < 5) examples.push(`${s.name}（${s.year} → ${earliest}）`);
          s.year = earliest;
          corrected++;
        }
      }
    }));
    const done = Math.min(i + CONCURRENCY, entries.length);
    if (done % 50 < CONCURRENCY || done === entries.length) {
      console.log(`  校正进度 ${done}/${entries.length} 组，已校正 ${corrected} 首`);
    }
  }
  const flagged = entries.reduce((a, g) => a + g.length, 0);
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

async function main() {
  const input = process.argv[2];
  const flags = process.argv.slice(3);
  if (!input) { console.error('用法: node music-age.js <网易云主页链接|用户ID> [--all | --ids=<id1,id2> | --list]'); process.exit(2); }
  const optAll = flags.includes('--all');
  const optList = flags.includes('--list');
  const idsFlag = flags.find((f) => f.startsWith('--ids='));
  const optIds = idsFlag ? new Set(idsFlag.slice(6).split(',').map((x) => Number(x.trim())).filter(Boolean)) : null;

  const uid = await resolveUid(input);
  const ud = await callApi(() => api.user_detail({ uid, ...BASE }), '用户信息查询');
  const profile = ud.body.profile;
  console.log(`用户：${profile.nickname}（ID ${uid}，Lv.${ud.body.level}）`);

  // 分页取全部公开歌单
  const playlists = [];
  for (let offset = 0; ; offset += 100) {
    const up = await callApi(() => api.user_playlist({ uid, limit: 100, offset, ...BASE }), '歌单列表查询');
    const list = up.body.playlist || [];
    playlists.push(...list);
    if (!up.body.more || !list.length) break;
    await sleep(200);
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

  // 聚合 trackIds 并跨歌单去重
  const idSet = new Set();
  let rawTotal = 0;
  for (const p of selected) {
    const ids = await getFullTrackIds(p);
    rawTotal += ids.length;
    for (const id of ids) idSet.add(id);
    await sleep(200);
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
        songs.push({ name: s.name, artist, album: s.al ? s.al.name : '', year, age: CURRENT_YEAR - year + 17 });
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
            metaById.set(s.id, { name: s.name, artist: (s.ar || []).map((a) => a.name).join(' / '), album: s.al ? s.al.name : '', year: y });
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
