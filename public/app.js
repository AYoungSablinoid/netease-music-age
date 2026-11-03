'use strict';
const CURRENT_YEAR = new Date().getFullYear();
const BATCH = 500;

const $ = (id) => document.getElementById(id);
const form = $('ageForm');
const input = $('linkInput');
const submitBtn = $('submitBtn');
const selectCard = $('selectCard');
const resultCard = $('resultCard');

let currentUser = null; // /api/user 的返回：{nickname, avatarUrl, level, playlists[]}
let currentUid = null;

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
async function correctSongs(list, onProgress) {
  const internalEarliest = new Map();
  for (const s of list) {
    if (!s.year) continue;
    const key = `${cleanTitle(s.name)}|${normName(s.artist.split(' / ')[0])}`;
    if (!internalEarliest.has(key) || s.year < internalEarliest.get(key)) internalEarliest.set(key, s.year);
  }
  const flagged = list.filter((s) => {
    if (!s.year) return false;
    if (FLAG_RE.test(`${s.name} ${s.album || ''}`)) return true;
    const key = `${cleanTitle(s.name)}|${normName(s.artist.split(' / ')[0])}`;
    return internalEarliest.get(key) <= s.year - 3;
  });
  let corrected = 0;
  for (let k = 0; k < flagged.length; k += 25) {
    const chunk = flagged.slice(k, k + 25);
    if (onProgress) onProgress(Math.min(k + 25, flagged.length), flagged.length);
    try {
      const { results } = await getJson('/api/original-years', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ songs: chunk.map((s) => ({ name: s.name, artist: s.artist.split(' / ')[0], album: s.album, year: s.year })) }),
      });
      chunk.forEach((s, j) => {
        const oy = results[j] && results[j].originalYear;
        if (oy) { s.year = oy; corrected++; }
      });
    } catch (e) { /* 校正失败不阻断主结果，保留专辑年份 */ }
  }
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
  hideError($('errorBox2'));
  resultCard.classList.add('hidden');
  $('calcBtn').disabled = true;
  try {
    // 拉取各歌单 trackIds 并去重
    const idSet = new Set();
    let rawTotal = 0;
    for (let i = 0; i < sel.length; i++) {
      progress2.show(`正在读取歌单「${sel[i].name}」…`, (i / sel.length) * 35, `第 ${i + 1} / ${sel.length} 个歌单`);
      const data = await getJson('/api/playlist?id=' + encodeURIComponent(sel[i].id));
      rawTotal += data.trackIds.length;
      for (const id of data.trackIds) idSet.add(id);
    }
    const ids = [...idSet];
    if (!ids.length) throw new Error('所选歌单里没有歌曲，无法计算。');

    // 分批查发行年份
    const songs = [];
    let noYear = 0;
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      const { songs: part } = await getJson('/api/songs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: batch }),
      });
      for (const s of part) {
        if (s.year) songs.push({ ...s });
        else noYear++;
      }
      const done = Math.min(i + BATCH, ids.length);
      progress2.show('正在查每首歌的发行年份…', 35 + (done / ids.length) * 55, `已处理 ${done} / ${ids.length} 首（去重后）`);
    }
    if (!songs.length) throw new Error('没有取到任何带发行年份的歌曲，无法计算。');
    // 校正重制/再版歌曲的年份（专辑年份会把结果算小），再统一换算单曲年龄
    const ageBeforeCorrection = Math.round(songs.reduce((a, s) => a + (CURRENT_YEAR - s.year + 17), 0) / songs.length);
    const correctedCount = await correctSongs(songs, (doneN, totalN) =>
      progress2.show('正在校正重制/再版歌曲的发行年份…', 95, `已检查 ${doneN} / ${totalN} 首疑似歌曲`));
    for (const s of songs) s.age = CURRENT_YEAR - s.year + 17;
    progress2.show('正在计算…', 100);
    renderResult(currentUser, sel, songs, noYear, rawTotal, ids.length, { correctedCount, ageBeforeCorrection });
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
  const corrNote = correction && correction.correctedCount
    ? `其中 ${correction.correctedCount} 首来自重制/再版/精选专辑，已按原版发行年份校正（不校正会算成 ${correction.ageBeforeCorrection} 岁）；`
    : '';
  $('rFoot').textContent = `${dupNote}${corrNote}参与计算 ${songs.length} 首，平均音乐年龄 ${avg.toFixed(1)} 岁（四舍五入为 ${musicAge} 岁）；另有 ${noYear} 首因缺发行年份未计入。单曲音乐年龄 = ${CURRENT_YEAR} − 发行年份 + 17。`;

  resultCard.classList.remove('hidden');
  resultCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
  loadRecordPanels(musicAge);
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
  input.value = '';
  input.focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
