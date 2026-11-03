# 音乐年龄测试（中文版 · 网易云）

**在线体验：[netease-music-age.onrender.com](https://netease-music-age.onrender.com/)** — 打开就能测，无需安装，粘贴网易云主页链接即可。

输入一个网易云音乐主页链接，勾选 TA 的任意公开歌单（「我喜欢的音乐」、自建歌单、收藏歌单都可以），根据这些歌单里的全部歌曲，算出 TA 的**音乐年龄**。适合不把歌都放在「喜欢」里、而是分类整理成多个歌单的人。

玩法来自日本站「音楽数珠つなぎ」的 30 MUSIC CHALLENGE：假设每首歌都是在它发行的那一年、你 17 岁时听到的，那么——

> **单曲音乐年龄 = 当前年份 − 发行年份 + 17**，全部歌曲取平均，就是你的音乐年龄。

比如一首 1969 年的歌：1969 年时 17 岁的人，现在 74 岁。歌单越老，音乐年龄越大。作为参照，原站公布的用户平均音乐年龄是 28 岁。

## 算法

很简单，一共三步：

1. **取年份**：对歌单里的每一首歌，取其所属专辑的发行年份（网易云接口的 `album.publishTime`）。
2. **逐首换算**：假设你是在这首歌发行的那一年、17 岁时听到它的，那么“这首歌的音乐年龄”就是那位 17 岁听众现在的年龄：
   `单曲音乐年龄 = 当前年份 − 发行年份 + 17`
3. **取平均**：把全部歌曲的单曲音乐年龄做算术平均、四舍五入取整，就是这个人的音乐年龄。

细节说明：

- 没有发行年份的歌曲（如部分新歌单曲）不参与计算，数量会在结果中单独注明；
- 不做加权——每首歌权重相同，算的是“歌单品味的平均年代”，不是“实际收听频次”；
- 选了多个歌单时先合并**去重**：同一首歌在几个歌单里重复出现，只算一次。

## 在线体验（网站版）

本项目自带一个完整的网站：打开页面 → 粘贴网易云主页链接 → 勾选要计入的歌单（默认勾选「我喜欢的音乐」+ 全部自建歌单，收藏的歌单可手动勾选）→ 自动拉取并算出音乐年龄，带进度条和结果卡，手机上也能用。正式站点就是顶部的在线体验地址（Render 免费实例闲置后会休眠，下次打开需等几十秒唤醒）。

**部署你自己的实例（一键部署到 Render，免费）：**

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/AYoungSablinoid/netease-music-age)

用 GitHub 账号登录后点部署，约 1 分钟即可得到一个 `https://netease-music-age.onrender.com` 形式的在线地址，任何人打开就能测。（免费实例闲置后会休眠，下次打开需等几十秒唤醒。）

也可以部署到任何支持 Node.js 的托管（Railway、自己的服务器等）：

```bash
npm install
npm start          # 监听 PORT 环境变量指定的端口，默认 3000
```

本地预览同理，执行 `npm start` 后打开 http://localhost:3000 。

网站结构：

- `server.js` — 零额外依赖的 Node 后端，只负责取数：解析主页/短链接、返回用户的全部歌单列表与任意歌单的全量 trackIds、批量查询歌曲发行年份（带缓存与失败重试）；
- `public/` — 前端页面（输入框、歌单多选、进度条、结果卡），跨歌单去重与音乐年龄计算在浏览器端完成；
- `music-age.js` — 命令行版（见下节），同样支持多歌单，与网站共用同一套算法。

## 快速开始（命令行版）

需要 Node.js 18+。

```bash
npm install
node music-age.js "https://music.163.com/user/home?id=1"
```

也可以直接传用户 ID：

```bash
node music-age.js 1
```

默认只算「我喜欢的音乐」。把歌分类放在不同歌单里的人，用参数选择歌单：

```bash
node music-age.js 1 --list            # 先列出全部公开歌单（含各自的 ID）
node music-age.js 1 --all             # 「我喜欢的音乐」+ 全部自建歌单
node music-age.js 1 --ids=123,456     # 只算指定的几个歌单（ID 见 --list）
```

运行后会输出：

- 音乐年龄和对应的“世代”标签（如：千禧一代的耳朵、泡沫经济世代的耳朵）
- 参与计算的歌曲数（以及因缺发行年份被剔除的数量）
- 歌单里最老和最新的一首歌
- 年代分布（60 年代 / 70 年代 / …）和出现最多的歌手 Top 5

同时在 `output/` 目录生成一份可分享的 HTML 结果卡（`music-age-<用户ID>.html`）和一份 JSON 原始结果。

## 工作原理

数据层不重复造轮子，直接使用开源项目 [Binaryify/NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi)（网易云音乐 Node.js API 的事实标准）：

1. 从主页链接解析用户 ID，分页取用户资料和**全部公开歌单**（按 `specialType === 5` 标出「我喜欢的音乐」、其余按是否收藏分为自建/收藏）；
2. 按使用者的选择（网页勾选，或命令行的 `--all` / `--ids`）确定要计入的歌单；
3. 用 `playlist_detail` 拿到每个歌单的**全量 trackIds**——千首级歌单也不会被截断（不足时再用 `playlist_track_all` 分页补齐），合并后跨歌单去重；
4. 按 500 首一批调用 `song_detail`，取每首歌的专辑发行时间（`album.publishTime`）；
5. 按上面的公式逐首换算后取平均。

全程**免登录、只读公开数据**，不保存任何账号信息。

## 注意事项

- **要计入的歌单需要设为公开**。如果对方把歌单设为隐私，匿名接口拿不到，程序会给出提示。
- 部分歌曲（尤其是新歌单曲）的专辑没有发行时间，这类歌曲会被剔除并在结果里注明数量。
- 若所在网络环境需要代理，程序会自动读取环境变量 `https_proxy` / `HTTPS_PROXY`。

## 致谢

- 数据接口：[Binaryify/NeteaseCloudMusicApi](https://github.com/Binaryify/NeteaseCloudMusicApi)
- 玩法原型：[音楽数珠つなぎ 30 MUSIC CHALLENGE](https://chainofmusic.crolivebose4.workers.dev/)（音楽年齢）

## License

MIT
