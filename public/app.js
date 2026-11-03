'use strict';
const CURRENT_YEAR = new Date().getFullYear();
const BATCH = 500;

const $ = (id) => document.getElementById(id);
const form = $('ageForm');
const input = $('linkInput');
const submitBtn = $('submitBtn');
const progressBox = $('progress');
const stageText = $('stageText');
const barInner = $('barInner');
const barText = $('barText');
const errorBox = $('errorBox');
const resultCard = $('resultCard');

function generationLabel(age) {
  if (age <= 22) return 'Z 世代的耳朵';
  if (age <= 32) return '千禧一代的耳朵';
  if (age <= 42) return '80 后的耳朵';
  if (age <= 52) return '70 后的耳朵';
  if (age <= 62) return '泡沫经济世代的耳朵';
  return '黄金年代的耳朵';
}

function setStage(text, percent, sub) {
  stageText.textContent = text;
  if (typeof percent === 'number') barInner.style.width = Math.round(percent) + '%';
  barText.textContent = sub || '';
}

function showError(msg) {
  errorBox.textContent = msg;
  errorBox.classList.remove('hidden');
}

async function getJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const link = input.value.trim();
  if (!link) { showError('请先粘贴网易云音乐主页链接。'); return; }
  errorBox.classList.add('hidden');
  resultCard.classList.add('hidden');
  progressBox.classList.remove('hidden');
  submitBtn.disabled = true;
  input.disabled = true;
  try {
    setStage('正在解析链接…', 2);
    const { uid } = await getJson('/api/resolve?url=' + encodeURIComponent(link));

    setStage('正在读取「我喜欢的音乐」歌单…', 6);
    const user = await getJson('/api/user?uid=' + encodeURIComponent(uid));
    const ids = user.trackIds || [];
    if (!ids.length) throw new Error('歌单里没有歌曲，无法计算。');

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
        if (s.year) songs.push({ ...s, age: CURRENT_YEAR - s.year + 17 });
        else noYear++;
      }
      const done = Math.min(i + BATCH, ids.length);
      setStage('正在查每首歌的发行年份…', 6 + (done / ids.length) * 90, `已处理 ${done} / ${ids.length} 首`);
    }
    if (!songs.length) throw new Error('没有取到任何带发行年份的歌曲，无法计算。');
    setStage('正在计算…', 100);
    renderResult(user, songs, noYear);
  } catch (e) {
    showError(e.message || '出错了，请重试。');
  } finally {
    progressBox.classList.add('hidden');
    submitBtn.disabled = false;
    input.disabled = false;
  }
});

function renderResult(user, songs, noYear) {
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
  $('rMeta').textContent = `歌单「${user.playlistName}」 · 共 ${user.trackCount} 首`;
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
  $('rFoot').textContent = `参与计算 ${songs.length} 首，平均音乐年龄 ${avg.toFixed(1)} 岁（四舍五入为 ${musicAge} 岁）；另有 ${noYear} 首因缺发行年份未计入。单曲音乐年龄 = ${CURRENT_YEAR} − 发行年份 + 17。`;

  resultCard.classList.remove('hidden');
  resultCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('againBtn').addEventListener('click', () => {
  resultCard.classList.add('hidden');
  input.value = '';
  input.focus();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
