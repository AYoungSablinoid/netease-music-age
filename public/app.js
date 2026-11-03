'use strict';
const CURRENT_YEAR = new Date().getFullYear();
const BATCH = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 有上限的并发池：按原顺序返回结果，任一任务失败则整体失败（与原来串行时的报错行为一致）
async function mapPool(items, conc, fn) {
  const out = new Array(items.length);
  let next = 0;
  let failed = null;
  const worker = async () => {
    while (next < items.length && !failed) {
      const i = next++;
      try { out[i] = await fn(items[i], i); } catch (e) { failed = e; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(conc, items.length) }, worker));
  if (failed) throw failed;
  return out;
}

const $ = (id) => document.getElementById(id);
const form = $('ageForm');
const input = $('linkInput');
const submitBtn = $('submitBtn');
const selectCard = $('selectCard');
const resultCard = $('resultCard');

let currentUser = null; // /api/user 的返回：{nickname, avatarUrl, level, playlists[]}
let currentUid = null;
let lastSongs = []; // 最近一次主计算计入的歌曲（分享图和手选挑战都用它）
let lastResult = null; // 最近一次主结果的汇总数据
let lastRecordSongs = []; // 听歌排行里的歌曲（周榜+累计榜并集，带年份），用作手选挑战的候选补充
let recordPromise = null; // 听歌排行加载的 Promise：打开手选挑战前要等它完成，否则候选池会缺排行里的歌
let lastTopSongs = []; // 历史最爱榜的歌曲（按播放顺序）

// 中位数音乐年龄：把每首歌的单曲年龄排序取中间值。
// 平均值容易被极端值拉动（比如一首 1936 年的歌单曲年龄 107 岁），中位数几乎不受影响，两个一起看更真实。
function medianAgeOf(list) {
  if (!list.length) return null;
  const ages = list.map((s) => CURRENT_YEAR - s.year + 17).sort((a, b) => a - b);
  const m = Math.floor(ages.length / 2);
  return ages.length % 2 ? ages[m] : Math.round((ages[m - 1] + ages[m]) / 2);
}

function generationLabel(age) {
  if (age <= 22) return 'Z 世代的耳朵';
  if (age <= 32) return '千禧一代的耳朵';
  if (age <= 42) return '80 后的耳朵';
  if (age <= 52) return '70 后的耳朵';
  if (age <= 62) return '泡沫经济世代的耳朵';
  return '黄金年代的耳朵';
}

const KIND_LABEL = { liked: '我喜欢的音乐', own: '自建', subscribed: '收藏' };

const progress1 = {
  box: $('progress'), stageEl: $('stageText'), barEl: $('barInner'), textEl: $('barText'),
  show(t, p, s) { this.box.classList.remove('hidden'); if (t) this.stageEl.textContent = t; if (typeof p === 'number') this.barEl.style.width = Math.round(p) + '%'; this.textEl.textContent = s || ''; },
  hide() { this.box.classList.add('hidden'); },
};
const progress2 = {
  box: $('progress2'), stageEl: $('stageText2'), barEl: $('barInner2'), textEl: $('barText2'),
  show(t, p, s) { this.box.classList.remove('hidden'); if (t) this.stageEl.textContent = t; if (typeof p === 'number') this.barEl.style.width = Math.round(p) + '%'; this.textEl.textContent = s || ''; },
  hide() { this.box.classList.add('hidden'); },
};

function showError(boxEl, msg) { boxEl.textContent = msg; boxEl.classList.remove('hidden'); }
function hideError(boxEl) { boxEl.classList.add('hidden'); }

async function getJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

// 重制/再版/精选专辑的歌：专辑年份晚于原版年份，向后端查最早版本年份并校正（原地改 year，返回校正首数）
// 疑似判定有两种：①歌名/专辑名带重制、再版、精选等关键词；
// ②同一批歌里已有同名同歌手的更早版本（早 3 年以上）——多半来自精选集/再版，即使专辑名不带关键词也能抓到
const FLAG_RE = /remaster|重制|复刻|deluxe|anniversary|reissue|expanded|special edition|纪念版|豪华版|精选|greatest hits|best of|collection|anthology|essential|金曲|\bhits\b|ultimate|definitive/i;
function cleanTitle(t) {
  return String(t || '')
    .replace(/[（(][^）)]*(remaster|remix|live|edit|version|ver\.?|deluxe)[^）)]*[）)]/gi, '')
    .replace(/[-–—]\s*(remaster|remix).*$/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}
const normName = (s) => String(s || '').toLowerCase().replace(/[\s・·.\-_]/g, '');
// 本次页面会话里已经查过原版年份的歌曲 ID：主结果阶段查过的歌，在听歌排行阶段不再重复发请求
const oyCheckedIds = new Set();

async function correctSongs(list, onProgress) {
  const keyOf = (s) => `${cleanTitle(s.name)}|${normName(s.artist.split(' / ')[0])}`;
  const byKey = new Map();
  const internalEarliest = new Map();
  for (const s of list) {
    if (!s.year) continue;
    const key = keyOf(s);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(s);
    if (!internalEarliest.has(key) || s.year < internalEarliest.get(key)) internalEarliest.set(key, s.year);
  }
  // 按组处理（与 CLI 同一套规则）：整组都能被批内最早版本直判、且最早版本本身不带重制标记的组，
  // 直接用批内年份校正、不发请求（实测约 1/5 的组可以这样跳过）；其余组才送后端批量查。
  const groups = new Map();
  for (const s of list) {
    if (!s.year) continue;
    const key = keyOf(s);
    if (FLAG_RE.test(`${s.name} ${s.album || ''}`) || internalEarliest.get(key) <= s.year - 3) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(s);
    }
  }
  const flaggedTotal = [...groups.values()].reduce((a, g) => a + g.length, 0);
  let corrected = 0;
  let processed = 0;
  const toSend = [];
  for (const [key, songs] of groups) {
    if (songs.every((s) => s.id != null && oyCheckedIds.has(s.id))) { processed += songs.length; continue; }
    const e = internalEarliest.get(key);
    const earliestCopies = (byKey.get(key) || []).filter((x) => x.year === e);
    const direct = songs.every((s) => e <= s.year - 3) && !earliestCopies.some((x) => FLAG_RE.test(`${x.name} ${x.album || ''}`));
    if (direct) {
      for (const s of songs) { s.year = e; corrected++; if (s.id != null) oyCheckedIds.add(s.id); }
      processed += songs.length;
    } else {
      toSend.push(...songs);
    }
  }
  if (onProgress && processed) onProgress(processed, flaggedTotal);
  // 每批 50 首（后端上限），2 批并行流水：后端内部还有全局并发闸和专辑级批量查详情，不会互相打架
  const chunks = [];
  for (let k = 0; k < toSend.length; k += 50) chunks.push(toSend.slice(k, k + 50));
  let ci = 0;
  const worker = async () => {
    while (ci < chunks.length) {
      const chunk = chunks[ci++];
      try {
        const { results } = await getJson('/api/original-years', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ songs: chunk.map((s) => ({ name: s.name, artist: s.artist.split(' / ')[0], album: s.album, year: s.year })) }),
        });
        chunk.forEach((s, j) => {
          const oy = results[j] && results[j].originalYear;
          if (oy) { s.year = oy; corrected++; }
          if (s.id != null) oyCheckedIds.add(s.id);
        });
      } catch (e) { /* 校正失败不阻断主结果，保留专辑年份 */ }
      processed += chunk.length;
      if (onProgress) onProgress(processed, flaggedTotal);
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, chunks.length) }, worker));
  return corrected;
}

// ---------- 第一步：解析链接，拉取歌单列表 ----------
form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const link = input.value.trim();
  if (!link) { showError($('errorBox'), '请先粘贴网易云音乐主页链接。'); return; }
  hideError($('errorBox'));
  selectCard.classList.add('hidden');
  resultCard.classList.add('hidden');
  submitBtn.disabled = true;
  input.disabled = true;
  try {
    progress1.show('正在解析链接…', 15);
    const { uid } = await getJson('/api/resolve?url=' + encodeURIComponent(link));
    currentUid = uid;
    progress1.show('正在读取歌单列表…', 60);
    currentUser = await getJson('/api/user?uid=' + encodeURIComponent(uid));
    progress1.show('读取完成', 100);
    renderSelect(currentUser);
  } catch (e) {
    showError($('errorBox'), e.message || '出错了，请重试。');
  } finally {
    progress1.hide();
    submitBtn.disabled = false;
    input.disabled = false;
  }
});

// ---------- 第二步：选择歌单 ----------
function renderSelect(user) {
  $('selNickname').textContent = user.nickname;
  const subN = user.playlists.filter((p) => p.kind === 'subscribed').length;
  $('selMeta').textContent = subN
    ? `共 ${user.playlists.length} 个公开歌单，其中 ${subN} 个是收藏的别人歌单`
    : `共 ${user.playlists.length} 个公开歌单`;
  const av = $('selAvatar');
  if (user.avatarUrl) {
    av.src = user.avatarUrl;
    av.classList.remove('hidden');
    av.onerror = () => av.classList.add('hidden');
  } else av.classList.add('hidden');

  const list = $('playlistList');
  list.innerHTML = '';
  for (const p of user.playlists) {
    const label = document.createElement('label');
    label.className = 'playlistRow';
    const checked = p.kind === 'liked' || p.kind === 'own';
    label.innerHTML =
      `<input type="checkbox" class="plCheck" data-id="${p.id}" ${checked ? 'checked' : ''}>` +
      (p.coverImgUrl ? `<img class="plCover" src="${p.coverImgUrl}" alt="" loading="lazy">` : '') +
      `<span class="plMain"><span class="plName"></span><span class="plSub"></span></span>` +
      `<span class="tag tag-${p.kind}">${KIND_LABEL[p.kind] || ''}</span>`;
    label.querySelector('.plName').textContent = p.name;
    label.querySelector('.plSub').textContent =
      (p.kind === 'subscribed' && p.creatorName ? `创建者 ${p.creatorName} · ` : '') + `${p.trackCount} 首`;
    list.appendChild(label);
  }
  list.querySelectorAll('.plCheck').forEach((cb) => cb.addEventListener('change', updateSummary));
  updateSummary();
  selectCard.classList.remove('hidden');
  selectCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function selectedPlaylists() {
  if (!currentUser) return [];
  const ids = new Set(
    [...document.querySelectorAll('.plCheck:checked')].map((cb) => Number(cb.dataset.id)),
  );
  return currentUser.playlists.filter((p) => ids.has(p.id));
}

function updateSummary() {
  const sel = selectedPlaylists();
  const total = sel.reduce((a, p) => a + p.trackCount, 0);
  $('selSummary').textContent = sel.length
    ? `已选 ${sel.length} 个歌单，合计 ${total} 首（跨歌单重复的歌只算一次）`
    : '请至少勾选一个歌单';
  $('calcBtn').disabled = sel.length === 0;
}

function setChecks(pred) {
  document.querySelectorAll('.plCheck').forEach((cb) => {
    const p = currentUser.playlists.find((x) => x.id === Number(cb.dataset.id));
    cb.checked = pred(p);
  });
  updateSummary();
}
$('selDefault').addEventListener('click', () => setChecks((p) => p.kind === 'liked' || p.kind === 'own'));
$('selAll').addEventListener('click', () => setChecks(() => true));
$('selNone').addEventListener('click', () => setChecks(() => false));

// ---------- 第三步：聚合所选歌单并计算 ----------
$('calcBtn').addEventListener('click', async () => {
  const sel = selectedPlaylists();
  if (!sel.length || !currentUser) return;
  oyCheckedIds.clear();
  hideError($('errorBox2'));
  resultCard.classList.add('hidden');
  $('calcBtn').disabled = true;
  try {
    // 拉取各歌单 trackIds 并去重：4 个歌单并发拉（歌单多的用户串行要等几分钟）；
    // 单个歌单失败不中断整体（300 个歌单里总有一两个会碰上接口抖动），失败的记下来在结果里注明
    const idSet = new Set();
    let rawTotal = 0;
    let plDone = 0;
    progress2.show('正在读取所选歌单…', 0, `共 ${sel.length} 个歌单`);
    const plResults = await mapPool(sel, 4, async (p) => {
      try {
        return { name: p.name, data: await getJson('/api/playlist?id=' + encodeURIComponent(p.id)) };
      } catch (e) {
        return { name: p.name, error: e };
      } finally {
        plDone++;
        progress2.show('正在读取所选歌单…', (plDone / sel.length) * 35, `已读取 ${plDone} / ${sel.length} 个歌单`);
      }
    });
    const failedPlaylists = [];
    for (const r of plResults) {
      if (r.error) { failedPlaylists.push(r.name); continue; }
      rawTotal += r.data.trackIds.length;
      for (const id of r.data.trackIds) idSet.add(id);
    }
    const ids = [...idSet];
    if (!ids.length) throw new Error('所选歌单里没有歌曲，无法计算。');

    // 分批查发行年份：1000 首一批、3 批并发（4 万首歌时串行要几分钟）
    const songs = [];
    let noYear = 0;
    const batches = [];
    for (let i = 0; i < ids.length; i += BATCH) batches.push(ids.slice(i, i + BATCH));
    let batchDone = 0;
    const parts = await mapPool(batches, 3, async (batch) => {
      const post = () => getJson('/api/songs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: batch }),
      });
      let part;
      try { ({ songs: part } = await post()); }
      catch (e) { await sleep(1500); ({ songs: part } = await post()); } // 整批失败多半是瞬时抖动，隔一会重试一次
      batchDone++;
      progress2.show('正在查每首歌的发行年份…', 35 + (batchDone / batches.length) * 55, `已处理 ${Math.min(batchDone * BATCH, ids.length)} / ${ids.length} 首（去重后）`);
      return part;
    });
    for (const part of parts) {
      for (const s of part) {
        if (s.year) songs.push({ ...s });
        else noYear++;
      }
    }
    if (!songs.length) throw new Error('没有取到任何带发行年份的歌曲，无法计算。');
    // 校正重制/再版歌曲的年份（专辑年份会把结果算小），再统一换算单曲年龄
    const ageBeforeCorrection = Math.round(songs.reduce((a, s) => a + (CURRENT_YEAR - s.year + 17), 0) / songs.length);
    const correctedCount = await correctSongs(songs, (doneN, totalN) =>
      progress2.show('正在校正重制/再版歌曲的发行年份…', 95, `已检查 ${doneN} / ${totalN} 首疑似歌曲`));
    for (const s of songs) s.age = CURRENT_YEAR - s.year + 17;
    progress2.show('正在计算…', 100);
    renderResult(currentUser, sel, songs, noYear, rawTotal, ids.length, { correctedCount, ageBeforeCorrection, failedPlaylists });
  } catch (e) {
    showError($('errorBox2'), e.message || '出错了，请重试。');
  } finally {
    progress2.hide();
    $('calcBtn').disabled = false;
  }
});

// ---------- 结果 ----------
function renderResult(user, selPlaylists, songs, noYear, rawTotal, uniqueTotal, correction) {
  const avg = songs.reduce((a, s) => a + s.age, 0) / songs.length;
  const musicAge = Math.round(avg);
  const medianAge = medianAgeOf(songs);
  lastSongs = songs;
  lastRecordSongs = [];
  lastTopSongs = [];
  // 新结果出来时，把上一轮的分享图和手选挑战状态清掉
  $('shareBox').classList.add('hidden');
  $('challengeBox').classList.add('hidden');
  $('chResult').classList.add('hidden');
  chSelected.clear();
  resetWizard();
  const sorted = [...songs].sort((a, b) => a.year - b.year);
  const oldest = sorted[0];
  const newest = sorted[sorted.length - 1];

  const decades = {};
  for (const s of songs) {
    const d = Math.floor(s.year / 10) * 10;
    decades[d] = (decades[d] || 0) + 1;
  }
  const maxDecade = Math.max(...Object.values(decades));

  const artistCount = {};
  for (const s of songs) {
    for (const a of s.artist.split(' / ')) if (a) artistCount[a] = (artistCount[a] || 0) + 1;
  }
  const topArtists = Object.entries(artistCount).sort((a, b) => b[1] - a[1]).slice(0, 5);

  $('rNickname').textContent = user.nickname;
  $('rMeta').textContent = `来自 ${selPlaylists.length} 个歌单 · 去重后 ${uniqueTotal} 首`;
  const avatar = $('avatar');
  if (user.avatarUrl) {
    avatar.src = user.avatarUrl;
    avatar.classList.remove('hidden');
    avatar.onerror = () => avatar.classList.add('hidden');
  } else avatar.classList.add('hidden');

  $('rAge').textContent = musicAge;
  $('rLabel').textContent = '= ' + generationLabel(musicAge);
  $('rMedian').textContent = `中位数音乐年龄 ${medianAge} 岁（一半的歌比它老、一半比它新；与平均值差得越多，说明越有极端老歌或新歌在拉动平均）`;
  lastResult = {
    nickname: user.nickname, musicAge, medianAge, avg,
    label: generationLabel(musicAge),
    counted: songs.length, noYear, uniqueTotal,
    oldest, newest, decades, topArtists, correction,
  };
  $('rOldest').textContent = oldest.name;
  $('rOldestSub').textContent = `${oldest.artist} · ${oldest.year} 年（单曲音乐年龄 ${oldest.age} 岁）`;
  $('rNewest').textContent = newest.name;
  $('rNewestSub').textContent = `${newest.artist} · ${newest.year} 年`;

  $('rDecades').innerHTML = Object.entries(decades)
    .sort((a, b) => a[0] - b[0])
    .map(([d, c]) => `<div class="decadeRow"><span class="dName">${d}年代</span><div class="dBarWrap"><div class="dBar" style="width:${Math.max(2, Math.round((c / maxDecade) * 100))}%"></div></div><span class="dCount">${c} 首 · ${((c / songs.length) * 100).toFixed(1)}%</span></div>`)
    .join('');

  $('rArtists').textContent = topArtists.map(([a, c]) => `${a}（${c} 首）`).join('、');
  const dupNote = rawTotal > uniqueTotal ? `所选歌单原始合计 ${rawTotal} 首，去重后 ${uniqueTotal} 首；` : '';
  const failNote = correction && correction.failedPlaylists && correction.failedPlaylists.length
    ? `另有 ${correction.failedPlaylists.length} 个歌单读取失败、未计入：${correction.failedPlaylists.slice(0, 5).join('、')}${correction.failedPlaylists.length > 5 ? ' 等' : ''}；`
    : '';
  const corrNote = correction && correction.correctedCount
    ? `其中 ${correction.correctedCount} 首来自重制/再版/精选专辑，已按原版发行年份校正（不校正会算成 ${correction.ageBeforeCorrection} 岁）；`
    : '';
  $('rFoot').textContent = `${dupNote}${failNote}${corrNote}参与计算 ${songs.length} 首，平均音乐年龄 ${avg.toFixed(1)} 岁（四舍五入为 ${musicAge} 岁），中位数音乐年龄 ${medianAge} 岁；另有 ${noYear} 首因缺发行年份未计入。单曲音乐年龄 = ${CURRENT_YEAR} − 发行年份 + 17。`;

  resultCard.classList.remove('hidden');
  resultCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  recordPromise = loadRecordPanels(musicAge);
}

// ---------- 听歌排行视角：历史最爱 Top100 + 最近一周 ----------
function deltaText(panelAge, mainAge) {
  const d = panelAge - mainAge;
  if (d <= -2) return `比歌单年龄年轻 ${-d} 岁`;
  if (d >= 2) return `比歌单年龄老 ${d} 岁`;
  return '和歌单年龄差不多';
}

async function loadRecordPanels(mainAge) {
  const box = $('recordBox');
  box.innerHTML = '<p class="recordNote">正在读取听歌排行…</p>';
  try {
    const rec = await getJson('/api/record?uid=' + encodeURIComponent(currentUid));
    if (!rec.available) {
      box.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'recordNote';
      p.textContent = rec.reason ? `这两项暂时算不了：${rec.reason}。` : '对方未公开听歌排行，这两项算不了。';
      box.appendChild(p);
      return;
    }
    const ids = [...new Set([...rec.week, ...rec.top].map((x) => x.id))];
    const byId = new Map();
    for (let i = 0; i < ids.length; i += BATCH) {
      const { songs } = await getJson('/api/songs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: ids.slice(i, i + BATCH) }),
      });
      for (const s of songs) byId.set(s.id, s);
    }
    await correctSongs([...byId.values()]);
    // 留给「30 首手选挑战」当候选：排行里的歌也在本次计算数据范围内
    lastRecordSongs = [...byId.values()].filter((s) => s.year);
    lastTopSongs = rec.top.map((x) => byId.get(x.id)).filter((s) => s && s.year);
    const panelAge = (chart) => {
      const ys = chart.map((x) => byId.get(x.id)).filter((s) => s && s.year);
      if (!ys.length) return null;
      return {
        age: Math.round(ys.reduce((a, s) => a + (CURRENT_YEAR - s.year + 17), 0) / ys.length),
        counted: ys.length,
        total: chart.length,
      };
    };
    const week = panelAge(rec.week);
    const top = panelAge(rec.top);
    const panelHtml = (title, panel) => panel
      ? `<div class="box"><div class="boxTitle">${title}</div><div class="boxMain">${panel.age} 岁</div><div class="boxSub">按 ${panel.counted} 首计 · ${deltaText(panel.age, mainAge)}</div></div>`
      : `<div class="box"><div class="boxTitle">${title}</div><div class="boxMain">—</div><div class="boxSub">没有可计算的数据</div></div>`;
    let verdict = '';
    if (week) {
      if (week.age <= mainAge - 2) verdict = '结论：最近一周实际在听的歌，明显比歌单收藏更年轻——TA 的口味正在往新歌走，音乐年龄在变年轻。';
      else if (week.age >= mainAge + 2) verdict = '结论：最近一周实际在听的歌，明显比歌单收藏更老——TA 最近在回头听老歌，音乐年龄在变老。';
      else verdict = '结论：最近一周实际在听的歌和歌单品味基本一致，音乐年龄很稳定。';
    }
    box.innerHTML =
      `<div class="grid">${panelHtml('历史最爱 · 播放最高 100 首', top)}${panelHtml('最近一周在听', week)}</div>` +
      (verdict ? `<p class="verdict"></p>` : '');
    if (verdict) box.querySelector('.verdict').textContent = verdict;
  } catch (e) {
    box.innerHTML = '<p class="recordNote">听歌排行读取失败，这两项暂时算不了。</p>';
  }
}

$('adjustBtn').addEventListener('click', () => {
  resultCard.classList.add('hidden');
  selectCard.classList.remove('hidden');
  selectCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

$('againBtn').addEventListener('click', () => {
  resultCard.classList.add('hidden');
  selectCard.classList.add('hidden');
  currentUser = null;
  currentUid = null;
  lastSongs = [];
  lastResult = null;
  lastRecordSongs = [];
  lastTopSongs = [];
  recordPromise = null;
  chSelected.clear();
  resetWizard();
  input.value = '';
  input.focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// ---------- 分享图 PNG ----------
// 用 Canvas 把结果画成一张 1080 宽的图：大字年龄、年代分布条、Top 歌手、最老的歌，方便发社交平台。
function rr(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
function wrapLines(ctx, text, maxWidth, maxLines) {
  const lines = [];
  let line = '';
  for (const ch of String(text)) {
    if (ctx.measureText(line + ch).width > maxWidth && line) {
      lines.push(line);
      line = ch;
      if (lines.length === maxLines) return lines;
    } else line += ch;
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines;
}
$('shareBtn').addEventListener('click', () => {
  if (!lastResult) return;
  const R = lastResult;
  const FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';
  const decadeEntries = Object.entries(R.decades).sort((a, b) => a[0] - b[0]);
  const W = 1080;
  const H = 1300 + decadeEntries.length * 54;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f6f6f8'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#ffffff'; rr(ctx, 40, 40, W - 80, H - 80, 36); ctx.fill();
  ctx.strokeStyle = '#e7e7ec'; ctx.lineWidth = 2; rr(ctx, 40, 40, W - 80, H - 80, 36); ctx.stroke();
  ctx.textAlign = 'center';
  ctx.fillStyle = '#8a8f98'; ctx.font = `600 34px ${FONT}`;
  ctx.fillText('音 乐 年 龄 测 试', W / 2, 140);
  ctx.fillStyle = '#22242a'; ctx.font = `700 52px ${FONT}`;
  ctx.fillText(wrapLines(ctx, R.nickname, W - 240, 1)[0] || '', W / 2, 215);
  ctx.fillStyle = '#e60026'; ctx.font = `800 250px ${FONT}`;
  const ageW = ctx.measureText(String(R.musicAge)).width;
  ctx.fillText(String(R.musicAge), W / 2 - 40, 480);
  ctx.font = `600 52px ${FONT}`;
  ctx.fillText('岁', W / 2 - 40 + ageW / 2 + 52, 480);
  ctx.fillStyle = '#22242a'; ctx.font = `600 44px ${FONT}`;
  ctx.fillText(R.label, W / 2, 560);
  ctx.fillStyle = '#8a8f98'; ctx.font = `34px ${FONT}`;
  ctx.fillText(`平均 ${R.avg.toFixed(1)} 岁 · 中位数 ${R.medianAge} 岁 · ${R.counted} 首歌参与计算`, W / 2, 620);
  ctx.strokeStyle = '#e7e7ec'; ctx.beginPath(); ctx.moveTo(110, 665); ctx.lineTo(W - 110, 665); ctx.stroke();
  // 年代分布
  let y = 735;
  ctx.textAlign = 'left';
  ctx.fillStyle = '#22242a'; ctx.font = `700 36px ${FONT}`;
  ctx.fillText('年代分布', 110, y); y += 58;
  const maxDecade = Math.max(...decadeEntries.map(([, c]) => c));
  ctx.font = `32px ${FONT}`;
  for (const [d, c] of decadeEntries) {
    ctx.fillStyle = '#22242a';
    ctx.fillText(`${d}年代`, 110, y);
    ctx.fillStyle = '#f0d9de'; rr(ctx, 300, y - 26, 520, 30, 15); ctx.fill();
    ctx.fillStyle = '#e60026'; rr(ctx, 300, y - 26, Math.max(30, Math.round((c / maxDecade) * 520)), 30, 15); ctx.fill();
    ctx.fillStyle = '#8a8f98';
    ctx.fillText(`${c} 首`, 845, y);
    y += 54;
  }
  y += 26;
  ctx.fillStyle = '#22242a'; ctx.font = `700 36px ${FONT}`;
  ctx.fillText('最爱歌手', 110, y); y += 52;
  ctx.font = `34px ${FONT}`; ctx.fillStyle = '#22242a';
  const artistText = R.topArtists.map(([a, c]) => `${a}（${c} 首）`).join('、');
  for (const line of wrapLines(ctx, artistText, W - 220, 2)) { ctx.fillText(line, 110, y); y += 48; }
  y += 22;
  ctx.font = `700 36px ${FONT}`;
  ctx.fillText('最老的歌', 110, y); y += 52;
  ctx.font = `34px ${FONT}`;
  const oldestText = `${R.oldest.name} — ${R.oldest.artist}（${R.oldest.year} 年）`;
  for (const line of wrapLines(ctx, oldestText, W - 220, 2)) { ctx.fillText(line, 110, y); y += 48; }
  if (R.correction && R.correction.correctedCount) {
    ctx.fillStyle = '#8a8f98'; ctx.font = `28px ${FONT}`;
    ctx.fillText(`其中 ${R.correction.correctedCount} 首重制/再版歌曲已按原版年份校正`, 110, y + 14);
  }
  ctx.textAlign = 'center';
  ctx.fillStyle = '#8a8f98'; ctx.font = `30px ${FONT}`;
  ctx.fillText('netease-music-age.onrender.com', W / 2, H - 78);
  const done = (url) => {
    $('shareImg').src = url;
    $('shareDownload').href = url;
    $('shareBox').classList.remove('hidden');
    $('shareBox').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
  if (canvas.toBlob) canvas.toBlob((b) => { if (b) done(URL.createObjectURL(b)); else done(canvas.toDataURL('image/png')); }, 'image/png');
  else done(canvas.toDataURL('image/png'));
});

// ---------- 30 首手选挑战 ----------
// 候选池 = 这次主计算计入的歌 + 听歌排行里的歌（按歌曲 ID 合并去重），按年份从老到新列出，
// 另给三个参考歌单一键预选：最老的 / 最新的 / 历史最爱（按当前挑战长度截取）。选满挑战长度才能计算。
const chSelected = new Set();
let chPool = [];
let chTarget = 20; // 挑战长度：可选 10 / 20 / 30（30 是原版长度），向导和自由选共用
let lastChallenge = null; // 最近一次挑战结果（挑战分享图用）
function buildChPool() {
  const byId = new Map();
  for (const s of [...lastSongs, ...lastRecordSongs]) {
    if (s && s.id != null && s.year && !byId.has(s.id)) byId.set(s.id, s);
  }
  chPool = [...byId.values()].sort((a, b) => a.year - b.year);
}
function updateChCount(extraMsg) {
  const n = chSelected.size;
  $('chCount').textContent =
    (extraMsg ? extraMsg + ' ' : '') +
    `候选 ${chPool.length} 首（来自这次计算的歌单和听歌排行，可手动添加），已选 ${n} / ${chTarget} 首` +
    (n === chTarget ? '，可以计算了' : n > chTarget ? '，多了，请取消几首' : `，还差 ${chTarget - n} 首`);
  $('chCalcBtn').disabled = n !== chTarget;
}
function renderChList() {
  const q = $('chSearch').value.trim().toLowerCase();
  const list = $('chList');
  list.innerHTML = '';
  let shown = 0;
  chPool.forEach((s, idx) => {
    if (shown >= 400) return;
    if (q && !`${s.name} ${s.artist}`.toLowerCase().includes(q)) return;
    shown++;
    const label = document.createElement('label');
    label.className = 'playlistRow';
    label.innerHTML =
      `<input type="checkbox" class="chCheck" data-idx="${idx}" ${chSelected.has(idx) ? 'checked' : ''}>` +
      `<span class="plMain"><span class="plName"></span><span class="plSub"></span></span>` +
      `<span class="tag">${s.year} 年</span>`;
    label.querySelector('.plName').textContent = s.name;
    label.querySelector('.plSub').textContent = s.artist;
    list.appendChild(label);
  });
  if (shown >= 400) {
    const p = document.createElement('p');
    p.className = 'recordNote';
    p.textContent = '候选太多，只显示前 400 首，用上面的搜索框筛选。';
    list.appendChild(p);
  }
}
$('chList').addEventListener('change', (e) => {
  if (!e.target.classList || !e.target.classList.contains('chCheck')) return;
  const idx = Number(e.target.dataset.idx);
  if (e.target.checked) chSelected.add(idx); else chSelected.delete(idx);
  updateChCount();
});
function chQuickPick(songs, emptyMsg) {
  if (!songs || !songs.length) { updateChCount(emptyMsg || '这个参考歌单暂时没有数据。'); return; }
  const idxById = new Map(chPool.map((s, i) => [s.id, i]));
  chSelected.clear();
  for (const s of songs) {
    const idx = idxById.get(s.id);
    if (idx != null) chSelected.add(idx);
    if (chSelected.size >= chTarget) break;
  }
  $('chSearch').value = '';
  renderChList();
  updateChCount();
}
$('challengeOpenBtn').addEventListener('click', async () => {
  if (!lastSongs.length) return;
  // 听歌排行还在加载时先等它完成再建候选池，否则池子会缺排行里的歌（之前点开太快只有歌单候选）
  if (recordPromise) {
    const btn = $('challengeOpenBtn');
    const oldText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '正在合并听歌排行候选…';
    try { await recordPromise; } catch (e) { /* 排行加载失败不阻断挑战，用现有候选 */ }
    btn.disabled = false;
    btn.textContent = oldText;
  }
  buildChPool();
  $('challengeBox').classList.remove('hidden');
  $('chResult').classList.add('hidden');
  renderChList();
  updateChCount();
  renderWizard();
  $('challengeBox').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});
$('chSearch').addEventListener('input', renderChList);
$('chOldest').addEventListener('click', () => chQuickPick([...chPool].sort((a, b) => a.year - b.year).slice(0, chTarget)));
$('chNewest').addEventListener('click', () => chQuickPick([...chPool].sort((a, b) => b.year - a.year).slice(0, chTarget)));
$('chTop').addEventListener('click', () => chQuickPick(lastTopSongs.slice(0, chTarget), '这个用户的听歌排行未公开或还没加载完，暂时没有「历史最爱」参考歌单。'));
$('chClear').addEventListener('click', () => { chSelected.clear(); renderChList(); updateChCount(); });
function showChallengeResult(picked, breakdownItems) {
  const avg = picked.reduce((a, s) => a + (CURRENT_YEAR - s.year + 17), 0) / picked.length;
  const musicAge = Math.round(avg);
  const median = medianAgeOf(picked);
  const sorted = [...picked].sort((a, b) => a.year - b.year);
  const oldest = sorted[0];
  const newest = sorted[sorted.length - 1];
  $('chAge').textContent = musicAge;
  $('chLabel').textContent = '= ' + generationLabel(musicAge);
  $('chMeta').textContent = `平均 ${avg.toFixed(1)} 岁 · 中位数 ${median} 岁 · 最老：${oldest.name}（${oldest.year} 年）· 最新：${newest.name}（${newest.year} 年）`;
  let cmp = '手选结果和歌单全量结果一样：你心中的代表作，就是你的日常品味。';
  if (lastResult) {
    const d = musicAge - lastResult.musicAge;
    if (d >= 1) cmp = `比歌单全量结果（${lastResult.musicAge} 岁）老 ${d} 岁：你心中的代表作，比日常歌单更老派。`;
    else if (d <= -1) cmp = `比歌单全量结果（${lastResult.musicAge} 岁）年轻 ${-d} 岁：你心中的代表作，比日常歌单更年轻。`;
  }
  $('chCompare').textContent = cmp;
  lastChallenge = { picked, breakdownItems, musicAge, avg, median, cmp };
  $('chShareBox').classList.add('hidden');
  const bd = $('chBreakdown');
  bd.innerHTML = '';
  if (breakdownItems && breakdownItems.length) {
    const h = document.createElement('h3');
    h.textContent = `我的 ${breakdownItems.length} 个命题答案`;
    bd.appendChild(h);
    for (const it of breakdownItems) {
      const row = document.createElement('div');
      row.className = 'wizAnswerRow';
      const q = document.createElement('span');
      q.className = 'q';
      q.textContent = `${it.no}. ${it.prompt}`;
      const s = document.createElement('span');
      s.textContent = `${it.song.name} — ${it.song.artist}`;
      const x = document.createElement('span');
      x.className = 'x';
      x.textContent = `${it.song.year} 年 · 单曲 ${CURRENT_YEAR - it.song.year + 17} 岁`;
      row.append(q, s, x);
      bd.appendChild(row);
    }
  }
  $('chResult').classList.remove('hidden');
  $('chResult').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// 挑战分享图：大字年龄 + 对比结论 + 全部选歌清单（向导模式带命题），1080 宽 PNG
$('chShareBtn').addEventListener('click', () => {
  if (!lastChallenge) return;
  const C = lastChallenge;
  const FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif';
  const wizard = !!(C.breakdownItems && C.breakdownItems.length);
  const rows = wizard
    ? C.breakdownItems.map((it) => ({ head: `${it.no}. ${it.prompt}`, main: `${it.song.name} — ${it.song.artist}`, sub: `${it.song.year} 年 · 单曲 ${CURRENT_YEAR - it.song.year + 17} 岁` }))
    : C.picked.map((s, i) => ({ head: '', main: `${i + 1}. ${s.name} — ${s.artist}`, sub: `${s.year} 年 · 单曲 ${CURRENT_YEAR - s.year + 17} 岁` }));
  const rowH = wizard ? 92 : 64;
  const W = 1080;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  const ctx = canvas.getContext('2d');
  ctx.font = `32px ${FONT}`;
  const cmpLines = wrapLines(ctx, C.cmp, W - 220, 2);
  const H = 700 + (cmpLines.length > 1 ? 45 : 0) + rows.length * rowH + 130;
  canvas.height = H; // 设高会重置画布状态，下面的绘制都会显式重设字体/对齐
  ctx.fillStyle = '#f6f6f8'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#ffffff'; rr(ctx, 40, 40, W - 80, H - 80, 36); ctx.fill();
  ctx.strokeStyle = '#e7e7ec'; ctx.lineWidth = 2; rr(ctx, 40, 40, W - 80, H - 80, 36); ctx.stroke();
  ctx.textAlign = 'center';
  ctx.fillStyle = '#8a8f98'; ctx.font = `600 34px ${FONT}`;
  ctx.fillText(wizard ? '命 题 手 选 挑 战' : '手 选 挑 战', W / 2, 140);
  ctx.fillStyle = '#22242a'; ctx.font = `700 52px ${FONT}`;
  ctx.fillText(wrapLines(ctx, lastResult ? lastResult.nickname : '', W - 240, 1)[0] || '', W / 2, 215);
  ctx.fillStyle = '#e60026'; ctx.font = `800 230px ${FONT}`;
  const ageW = ctx.measureText(String(C.musicAge)).width;
  ctx.fillText(String(C.musicAge), W / 2 - 40, 450);
  ctx.font = `600 52px ${FONT}`;
  ctx.fillText('岁', W / 2 - 40 + ageW / 2 + 52, 450);
  ctx.fillStyle = '#22242a'; ctx.font = `600 42px ${FONT}`;
  ctx.fillText(generationLabel(C.musicAge), W / 2, 525);
  ctx.fillStyle = '#8a8f98'; ctx.font = `32px ${FONT}`;
  ctx.fillText(`手选 ${C.picked.length} 首 · 平均 ${C.avg.toFixed(1)} 岁 · 中位数 ${C.median} 岁`, W / 2, 580);
  cmpLines.forEach((line, i) => ctx.fillText(line, W / 2, 625 + i * 45));
  const divY = 660 + (cmpLines.length > 1 ? 45 : 0);
  ctx.strokeStyle = '#e7e7ec'; ctx.beginPath(); ctx.moveTo(110, divY); ctx.lineTo(W - 110, divY); ctx.stroke();
  let y = divY + 55;
  ctx.textAlign = 'left';
  for (const r of rows) {
    if (r.head) {
      ctx.fillStyle = '#8a8f98'; ctx.font = `28px ${FONT}`;
      ctx.fillText(wrapLines(ctx, r.head, W - 220, 1)[0] || '', 110, y);
      y += 38;
    }
    ctx.fillStyle = '#22242a'; ctx.font = `600 32px ${FONT}`;
    const mainLines = wrapLines(ctx, r.main, W - 380, 1);
    ctx.fillText(mainLines[0] || '', 110, y);
    ctx.fillStyle = '#8a8f98'; ctx.font = `30px ${FONT}`;
    ctx.textAlign = 'right';
    ctx.fillText(r.sub, W - 110, y);
    ctx.textAlign = 'left';
    y += rowH - (r.head ? 38 : 0);
  }
  ctx.textAlign = 'center';
  ctx.fillStyle = '#8a8f98'; ctx.font = `30px ${FONT}`;
  ctx.fillText('netease-music-age.onrender.com', W / 2, H - 78);
  const done = (url) => {
    $('chShareImg').src = url;
    $('chShareDownload').href = url;
    $('chShareBox').classList.remove('hidden');
    $('chShareBox').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
  if (canvas.toBlob) canvas.toBlob((b) => { if (b) done(URL.createObjectURL(b)); else done(canvas.toDataURL('image/png')); }, 'image/png');
  else done(canvas.toDataURL('image/png'));
});
$('chCalcBtn').addEventListener('click', () => {
  const picked = [...chSelected].map((i) => chPool[i]).filter(Boolean);
  if (picked.length !== chTarget) return;
  showChallengeResult(picked, null);
});

// 手动添加歌曲：候选里没有的歌（如流媒体上找不到的宝藏歌）由用户自己填歌名/音乐人/年份。
// 加到候选池末尾（不重排，保证已选下标不错位）；池里已有同名同歌手则直接复用那首。
let customSeq = 0;
function addCustomSong(name, artist, year) {
  name = String(name || '').trim();
  artist = String(artist || '').trim();
  year = Number(year);
  if (!name || !artist || !Number.isInteger(year) || year < 1900 || year > CURRENT_YEAR) return -1;
  const dup = chPool.findIndex((s) => s.name.toLowerCase() === name.toLowerCase() && s.artist.toLowerCase() === artist.toLowerCase());
  if (dup >= 0) return dup;
  chPool.push({ id: 'custom-' + (++customSeq), name, artist, album: '手动添加', year, custom: true });
  return chPool.length - 1;
}
$('chCustomBtn').addEventListener('click', () => {
  const idx = addCustomSong($('chCustomName').value, $('chCustomArtist').value, $('chCustomYear').value);
  if (idx < 0) { $('chCustomMsg').textContent = '请填写歌名、音乐人，以及 1900–' + CURRENT_YEAR + ' 之间的发行年份。'; return; }
  if (!chSelected.has(idx) && chSelected.size >= chTarget) { $('chCustomMsg').textContent = '已选满，先取消一首再添加。'; return; }
  $('chCustomMsg').textContent = '';
  $('chCustomName').value = ''; $('chCustomArtist').value = ''; $('chCustomYear').value = '';
  chSelected.add(idx);
  $('chSearch').value = '';
  renderChList();
  updateChCount();
});

// ---------- 命题向导（参考原站 30 MUSIC CHALLENGE：一题一首、逐题作答） ----------
// 30 个命题分三类：日常与心情 / 标题与特征 / 回忆与喜好。命题文案为本站自拟，玩法结构参考原站：
// 一次只面对一题，在候选里搜索点选作答，随时看进度和已答清单，答满 30 题出分并逐题回顾。
const PROMPTS = [
  ['日常与心情', '今天听的第一首歌'],
  ['日常与心情', '雨天想听的歌'],
  ['日常与心情', '睡前想听的歌'],
  ['日常与心情', '能把自己从低谷里拉起来的歌'],
  ['日常与心情', '心情不好时反复听的歌'],
  ['日常与心情', '听了就忍不住跟唱的歌'],
  ['日常与心情', '通勤路上想听的歌'],
  ['日常与心情', '想在自己的葬礼上放的歌'],
  ['日常与心情', '属于你的夏日之歌'],
  ['日常与心情', '深夜一个人时想听的歌'],
  ['标题与特征', '歌名里带「星」的歌'],
  ['标题与特征', '歌名里带花名的歌'],
  ['标题与特征', '歌名里带地名的歌'],
  ['标题与特征', '和食物有关的歌'],
  ['标题与特征', '不到三分钟的歌'],
  ['标题与特征', '歌名只有一个字的歌'],
  ['标题与特征', '吉他 solo 让你起鸡皮疙瘩的歌'],
  ['标题与特征', '节奏或速度中途变化的歌'],
  ['标题与特征', '以英文歌词为主的歌'],
  ['标题与特征', '五人及以上团体 / 乐队的歌'],
  ['回忆与喜好', '你觉得被严重低估的歌'],
  ['回忆与喜好', '想安利别人先看歌词的歌'],
  ['回忆与喜好', '你的音乐启蒙之歌'],
  ['回忆与喜好', '听过现场后才爱上的歌'],
  ['回忆与喜好', '想戴耳机逐字细听的歌'],
  ['回忆与喜好', '想送给最重要的人的歌'],
  ['回忆与喜好', '两位你喜欢的歌手合作的歌'],
  ['回忆与喜好', '主打之外最爱的 B 面曲'],
  ['回忆与喜好', '流媒体上找不到的宝藏歌'],
  ['回忆与喜好', '你自己的主题曲'],
];
let wizAnswers = []; // 每题选中的候选下标（chPool 下标），null 为未答；长度 = 当前挑战长度
let wizCur = 0;
let wizPrompts = []; // 当前长度下实际使用的命题（从 30 题里均匀抽取，首尾固定）
// 按挑战长度从 30 个命题里均匀抽题：10/20 题时三类命题都覆盖，最后一题始终是「你自己的主题曲」
function pickPrompts(n) {
  if (n >= PROMPTS.length) return PROMPTS.slice();
  const idxs = [];
  for (let i = 0; i < n; i++) idxs.push(Math.round((i * (PROMPTS.length - 1)) / (n - 1)));
  return [...new Set(idxs)].map((i) => PROMPTS[i]);
}
function resetWizard() {
  wizPrompts = pickPrompts(chTarget);
  wizAnswers = new Array(wizPrompts.length).fill(null);
  wizCur = 0;
}
resetWizard();
function wizUsedBy(idx) {
  for (let i = 0; i < wizAnswers.length; i++) if (wizAnswers[i] === idx) return i;
  return -1;
}
function wizAnsweredCount() { return wizAnswers.filter((x) => x != null).length; }
function renderWizard() {
  // 进度格
  const slots = $('wizSlots');
  slots.innerHTML = '';
  wizPrompts.forEach((p, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'wizSlot' + (wizAnswers[i] != null ? ' filled' : '') + (i === wizCur ? ' current' : '');
    b.textContent = wizAnswers[i] != null ? '✓' : String(i + 1);
    b.title = `第 ${i + 1} 题：${p[1]}`;
    b.addEventListener('click', () => { wizCur = i; $('wizSearch').value = ''; renderWizard(); });
    slots.appendChild(b);
  });
  // 进度文字（含已答歌曲的实时平均预览，和原站一样每首歌下面能看到它的单曲音乐年龄）
  const answered = wizAnswers.filter((x) => x != null).map((i) => chPool[i]).filter(Boolean);
  const n = answered.length;
  let preview = '';
  if (n) {
    const avg = answered.reduce((a, s) => a + (CURRENT_YEAR - s.year + 17), 0) / n;
    preview = ` · 已答歌曲当前平均音乐年龄约 ${Math.round(avg)} 岁（预览，答满后为准）`;
  }
  $('wizProgress').textContent = `已答 ${n} / ${wizPrompts.length} 题${preview}`;
  // 当前命题卡
  const [cat, prompt] = wizPrompts[wizCur];
  $('wizStep').textContent = `第 ${wizCur + 1} / ${wizPrompts.length} 题`;
  $('wizCat').textContent = cat;
  $('wizPrompt').textContent = prompt;
  const curIdx = wizAnswers[wizCur];
  const curSong = curIdx != null ? chPool[curIdx] : null;
  $('wizCurrent').innerHTML = curSong
    ? `本题已选：<b></b>（${curSong.year} 年，单曲音乐年龄 ${CURRENT_YEAR - curSong.year + 17} 岁）——在下面点另一首即可更换`
    : '本题还没选：在下面搜索点选一首，或用快捷按钮先填一首';
  if (curSong) $('wizCurrent').querySelector('b').textContent = `${curSong.name} — ${curSong.artist}`;
  // 候选列表：排除已被其他题选走的歌，本题已选的置顶标出
  const q = $('wizSearch').value.trim().toLowerCase();
  const list = $('wizList');
  list.innerHTML = '';
  let shown = 0;
  chPool.forEach((s, idx) => {
    if (shown >= 30) return;
    if (q && !`${s.name} ${s.artist}`.toLowerCase().includes(q)) return;
    const usedBy = wizUsedBy(idx);
    if (usedBy >= 0 && usedBy !== wizCur) return;
    shown++;
    const row = document.createElement('div');
    row.className = 'playlistRow wizPick';
    row.innerHTML =
      `<span class="plMain"><span class="plName"></span><span class="plSub"></span></span>` +
      `<span class="tag">${usedBy === wizCur ? '本题已选 · ' : ''}${s.year} 年 · 单曲 ${CURRENT_YEAR - s.year + 17} 岁</span>`;
    row.querySelector('.plName').textContent = s.name;
    row.querySelector('.plSub').textContent = s.artist;
    row.addEventListener('click', () => wizAnswer(idx));
    list.appendChild(row);
  });
  if (!shown) {
    const p = document.createElement('p');
    p.className = 'recordNote';
    p.textContent = q ? '候选里没有匹配的歌，换个关键词试试。' : '候选不足或都已被其他题选走。';
    list.appendChild(p);
  }
  // 已答清单
  const box = $('wizAnswers');
  box.innerHTML = '';
  wizPrompts.forEach((p, i) => {
    const ai = wizAnswers[i];
    if (ai == null) return;
    const s = chPool[ai];
    if (!s) return;
    const row = document.createElement('div');
    row.className = 'wizAnswerRow';
    const qEl = document.createElement('span');
    qEl.className = 'q';
    qEl.textContent = `${i + 1}. ${p[1]}`;
    const sEl = document.createElement('span');
    sEl.textContent = `${s.name} — ${s.artist}（${s.year} 年）`;
    const x = document.createElement('button');
    x.type = 'button';
    x.className = 'mini x';
    x.textContent = '改';
    x.addEventListener('click', () => { wizCur = i; $('wizSearch').value = ''; renderWizard(); $('wizSlots').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
    row.append(qEl, sEl, x);
    box.appendChild(row);
  });
  $('wizCalcBtn').disabled = wizAnsweredCount() !== wizPrompts.length;
  $('wizPrevBtn').disabled = wizCur === 0;
  $('wizNextBtn').disabled = wizCur === wizPrompts.length - 1;
}
function wizAnswer(idx) {
  wizAnswers[wizCur] = idx;
  $('wizSearch').value = '';
  // 自动前进到下一道未答题（都答完则停留在最后一题）
  const total = wizAnswers.length;
  let next = -1;
  for (let k = 1; k <= total; k++) {
    const j = (wizCur + k) % total;
    if (wizAnswers[j] == null) { next = j; break; }
  }
  if (next >= 0) wizCur = next;
  renderWizard();
}
function wizFillFirst(pred, emptyMsg) {
  const idx = chPool.findIndex((s, i) => pred(s) && (wizUsedBy(i) < 0 || wizUsedBy(i) === wizCur));
  if (idx < 0) { $('wizProgress').textContent = emptyMsg; return; }
  wizAnswer(idx);
}
$('wizOldestBtn').addEventListener('click', () => wizFillFirst(() => true, '没有可选的最老歌曲了。'));
$('wizNewestBtn').addEventListener('click', () => {
  for (let i = chPool.length - 1; i >= 0; i--) {
    const usedBy = wizUsedBy(i);
    if (usedBy < 0 || usedBy === wizCur) { wizAnswer(i); return; }
  }
  $('wizProgress').textContent = '没有可选的最新歌曲了。';
});
$('wizRandomBtn').addEventListener('click', () => {
  const free = chPool.map((s, i) => i).filter((i) => { const u = wizUsedBy(i); return u < 0 || u === wizCur; });
  if (!free.length) { $('wizProgress').textContent = '没有可选的歌曲了。'; return; }
  wizAnswer(free[Math.floor(Math.random() * free.length)]);
});
$('wizClearBtn').addEventListener('click', () => { wizAnswers[wizCur] = null; renderWizard(); });
$('wizPrevBtn').addEventListener('click', () => { if (wizCur > 0) { wizCur--; $('wizSearch').value = ''; renderWizard(); } });
$('wizNextBtn').addEventListener('click', () => { if (wizCur < wizPrompts.length - 1) { wizCur++; $('wizSearch').value = ''; renderWizard(); } });
$('wizSearch').addEventListener('input', renderWizard);
$('wizCalcBtn').addEventListener('click', () => {
  if (wizAnsweredCount() !== wizPrompts.length) return;
  const picked = wizAnswers.map((i) => chPool[i]).filter(Boolean);
  const items = wizPrompts.map((p, i) => ({ no: i + 1, prompt: p[1], song: chPool[wizAnswers[i]] }));
  showChallengeResult(picked, items);
});
$('wizCustomBtn').addEventListener('click', () => {
  const idx = addCustomSong($('wizCustomName').value, $('wizCustomArtist').value, $('wizCustomYear').value);
  if (idx < 0) { $('wizCustomMsg').textContent = '请填写歌名、音乐人，以及 1900–' + CURRENT_YEAR + ' 之间的发行年份。'; return; }
  const usedBy = wizUsedBy(idx);
  if (usedBy >= 0 && usedBy !== wizCur) { $('wizCustomMsg').textContent = '这首歌已经用在第 ' + (usedBy + 1) + ' 题了，换一首吧。'; return; }
  $('wizCustomMsg').textContent = '';
  $('wizCustomName').value = ''; $('wizCustomArtist').value = ''; $('wizCustomYear').value = '';
  wizAnswer(idx);
});

// 挑战长度切换：向导换题组、自由选换目标数，两边已选都清空
function setChCount(n) {
  chTarget = n;
  document.querySelectorAll('.chCountBtn').forEach((b) => b.classList.toggle('active', Number(b.dataset.n) === n));
  chSelected.clear();
  resetWizard();
  $('chOldest').textContent = `参考：最老的 ${n} 首`;
  $('chNewest').textContent = `参考：最新的 ${n} 首`;
  $('chTop').textContent = `参考：历史最爱 ${n} 首`;
  $('wizCalcBtn').textContent = `答满 ${n} 题，算我的命题音乐年龄`;
  $('tabFree').textContent = '自由选';
  $('chResult').classList.add('hidden');
  if (!$('challengeBox').classList.contains('hidden')) {
    renderChList();
    updateChCount();
    renderWizard();
  }
}
document.querySelectorAll('.chCountBtn').forEach((b) =>
  b.addEventListener('click', () => setChCount(Number(b.dataset.n))));
function setChMode(mode) {
  const wiz = mode === 'wizard';
  $('chWizardMode').classList.toggle('hidden', !wiz);
  $('chFreeMode').classList.toggle('hidden', wiz);
  $('tabWizard').classList.toggle('active', wiz);
  $('tabFree').classList.toggle('active', !wiz);
  if (wiz) renderWizard(); else { renderChList(); updateChCount(); }
}
$('tabWizard').addEventListener('click', () => setChMode('wizard'));
$('tabFree').addEventListener('click', () => setChMode('free'));
