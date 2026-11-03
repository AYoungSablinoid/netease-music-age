#!/usr/bin/env node
/**
 * 音乐年龄测试（中文版）
 * 输入网易云音乐主页链接 -> 取「喜欢的音乐」歌单全部歌曲
 * -> 按专辑发行年份换算音乐年龄：假设每首歌都是在发行那年 17 岁时听的，
 *    单曲音乐年龄 = 当前年份 - 发行年份 + 17，取全部平均。
 * 数据层基于开源项目 Binaryify/NeteaseCloudMusicApi（免登录，只读公开数据）。
 *
 * 用法: node music-age.js <主页链接|用户ID>
 *   例: node music-age.js "https://music.163.com/user/home?id=1"
 */
const fs = require('fs');
const path = require('path');
const api = require('NeteaseCloudMusicApi');

const PROXY = process.env.https_proxy || process.env.HTTPS_PROXY || '';
const BASE = { proxy: PROXY, realIP: true };
const CURRENT_YEAR = new Date().getFullYear();
const BATCH = 500;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function main() {
  const input = process.argv[2];
  if (!input) { console.error('用法: node music-age.js <网易云主页链接|用户ID>'); process.exit(2); }

  const uid = await resolveUid(input);
  const ud = await api.user_detail({ uid, ...BASE });
  const profile = ud.body.profile;
  console.log(`用户：${profile.nickname}（ID ${uid}，Lv.${ud.body.level}）`);

  const up = await api.user_playlist({ uid, limit: 30, ...BASE });
  const playlists = up.body.playlist || [];
  const liked = playlists.find((p) => p.specialType === 5);
  if (!liked) {
    throw new Error('没有找到公开的「喜欢的音乐」歌单。可能该歌单被设为隐私，请在网易云 App 里把「我喜欢的音乐」设为公开后重试。');
  }
  console.log(`歌单：${liked.name}，共 ${liked.trackCount} 首`);

  // 全部 trackIds（playlist_detail 的 trackIds 是完整列表；不足时用 track/all 分页补齐）
  const pd = await api.playlist_detail({ id: liked.id, ...BASE });
  let trackIds = (pd.body.playlist.trackIds || []).map((t) => t.id);
  if (trackIds.length < liked.trackCount) {
    const seen = new Set(trackIds);
    for (let offset = 0; offset < liked.trackCount; offset += 1000) {
      const ta = await api.playlist_track_all({ id: liked.id, limit: 1000, offset, ...BASE });
      for (const s of ta.body.songs || []) if (!seen.has(s.id)) { seen.add(s.id); trackIds.push(s.id); }
      if ((ta.body.songs || []).length === 0) break;
      await sleep(300);
    }
  }
  console.log(`已取得 ${trackIds.length} 首的 ID，开始批量查询发行年份…`);

  // 分批取歌曲详情 -> 专辑发行年份
  const songs = [];
  let noYear = 0;
  for (let i = 0; i < trackIds.length; i += BATCH) {
    const batch = trackIds.slice(i, i + BATCH);
    const sd = await api.song_detail({ ids: batch.join(','), ...BASE });
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

  // 统计
  const avg = songs.reduce((a, s) => a + s.age, 0) / songs.length;
  const musicAge = Math.round(avg);
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

  const result = {
    nickname: profile.nickname, uid, playlistName: liked.name,
    total: liked.trackCount, counted: songs.length, noYear,
    musicAge, avgAge: +avg.toFixed(1), label: generationLabel(musicAge),
    oldest, newest, decades, topArtists,
    generatedAt: new Date().toISOString(),
  };

  console.log('\n========== 结果 ==========');
  console.log(`${profile.nickname} 的音乐年龄是 ${musicAge} 岁（= ${result.label}）`);
  console.log(`参与计算 ${songs.length} 首（另有 ${noYear} 首缺发行年份未计入）`);
  console.log(`最老的歌：${oldest.name} — ${oldest.artist}（${oldest.year} 年，单曲音乐年龄 ${oldest.age} 岁）`);
  console.log(`最新的歌：${newest.name} — ${newest.artist}（${newest.year} 年）`);
  console.log('年代分布：', Object.entries(decades).sort((a, b) => a[0] - b[0]).map(([d, c]) => `${d}年代 ${c} 首`).join('、'));
  console.log('最爱年代歌手 Top5：', topArtists.map(([a, c]) => `${a}（${c} 首）`).join('、'));

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
<h1>${profile.nickname} 的音乐年龄</h1><div class="sub">来自歌单「${liked.name}」，共 ${songs.length} 首参与计算</div>
<div class="age">${musicAge} 岁</div><div class="label">= ${result.label}</div>
<div class="grid"><div class="box">最老的歌<br><b>${oldest.name}</b><br>${oldest.artist} · ${oldest.year} 年</div>
<div class="box">最新的歌<br><b>${newest.name}</b><br>${newest.artist} · ${newest.year} 年</div></div>
<h3 style="margin:12px 0 6px">年代分布</h3>${decadeRows}
<h3 style="margin:14px 0 6px">歌单里最多的歌手</h3><div style="font-size:14px">${topArtists.map(([a, c]) => `${a}（${c} 首）`).join('、')}</div>
<div class="foot">算法：假设每首歌都是在发行那年 17 岁时听的，单曲音乐年龄 = ${CURRENT_YEAR} − 发行年份 + 17，取全部平均（四舍五入）。另有 ${noYear} 首缺发行年份未计入。作为参照，日本原站「音楽数珠つなぎ」公布的用户平均音乐年龄为 28 岁。数据来自网易云公开接口（NeteaseCloudMusicApi）。</div>
</div></body></html>`;
  const file = path.join(outDir, `music-age-${uid}.html`);
  fs.writeFileSync(file, html);
  fs.writeFileSync(path.join(outDir, `music-age-${uid}.json`), JSON.stringify(result, null, 2));
  console.log(`\n结果卡已生成：${file}`);
}

main().catch((e) => { console.error('失败：', e.message || e); process.exit(1); });
