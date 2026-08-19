# 漫游簿 · 共同旅行地图

一个无需构建即可运行的互动旅行网页。世界地图会以可旋转、可缩放的地球呈现，并加载 Natural Earth 的全球省、州、自治区级边界。登录后，地图记录、邀请码和旅行照片会通过 Supabase 在朋友之间实时同步。

## 已实现

- 地球投影、拖动旋转、滚轮缩放与世界视图复位
- 全球省、州、自治区级区块点击、搜索和定位
- “想去 / 去过”两种状态、筛选和旅行统计
- 邮箱免密码登录
- 每位用户自动生成唯一的 10 位邀请码
- 通过邀请码加入朋友的共同地图
- 共创成员实时同步地区状态、文字和照片
- 私有照片存储与成员权限控制
- 网页内生成的低音量环境背景音乐
- 桌面端与移动端响应式布局

## 本地运行

推荐使用本地静态服务器：

```powershell
python -m http.server 4173
```

然后打开 `http://localhost:4173`。

## 配置 Supabase 共创功能

1. 在 Supabase 新建一个项目。
2. 打开项目的 SQL Editor，执行 `supabase/migrations/202608190001_wanderbook_collaboration.sql`。
3. 在 Authentication 的 URL Configuration 中配置：
   - Site URL：`https://2684708269-cmyk.github.io/manyou-book/`
   - Redirect URLs：同时加入上面的 GitHub Pages 地址和 `http://localhost:4173/`
4. 在项目设置的 API 页面复制 Project URL 和 Publishable/Anon Key，填入 `supabase-config.js`：

```js
window.WANDERBOOK_SUPABASE = {
  url: "https://你的项目.supabase.co",
  anonKey: "你的 Publishable 或 anon key"
};
```

浏览器端的 Publishable/Anon Key 可以公开；数据安全依靠迁移文件中配置的 Row Level Security。不要把 `service_role` key 放进本仓库。

## GitHub Pages

仓库设置中将 Pages 的来源设为 `Deploy from a branch`，分支选择 `main`，目录选择 `/ (root)`。推送到 `main` 后，网站会在几分钟内更新：

<https://2684708269-cmyk.github.io/manyou-book/>

地图渲染库、Supabase 客户端和行政区数据通过 CDN 加载，因此首次打开需要联网。
