# Three.js XR Avatar Platform

一套以 Three.js、React、WebXR 與 VRM 為核心的跨裝置 XR 角色展示平台，主要用於 Meta Quest 3、桌機與行動裝置的課堂 Demo、學生專題與展覽展示。

## 主要功能

- 上傳並顯示 VRM 角色
- Meta Quest WebXR 沉浸式展示
- 地面 Hit Test 放置角色
- 手勢操作角色旋轉與縮放
- 角色放置後自動面向頭盔
- Mixamo 動作重定向
- 表情、音訊嘴型與 Webcam Face Tracking
- Quest Launch Code 專案載入
- 展覽模式與 Session 自動恢復
- MindAR 行動裝置 AR 模式

## 技術堆疊

- React 19
- Three.js
- `@pixiv/three-vrm`
- WebXR Device API
- MediaPipe Tasks Vision
- MindAR
- Vite / Vinext
- Netlify Functions
- Netlify Blobs

## 本機開發

需求：Node.js 22.13 或更新版本。

```bash
npm ci
npm run dev:netlify
```

Netlify 本機開發環境：

```bash
npx netlify dev
```

## 建置

Netlify：

```bash
npm run build:netlify
```

輸出目錄為 `netlify-dist/`。

ChatGPT Sites：

```bash
npm run build
```

## 部署到 Netlify

專案已包含 `netlify.toml`。連接 GitHub Repository 後，Netlify 會自動使用：

- Build command：`npm run build:netlify`
- Publish directory：`netlify-dist`
- Functions directory：`netlify/functions`
- Node.js：22

WebXR 與相機功能必須使用 HTTPS。Quest 3 建議以 Meta Quest Browser 實機驗證。

## Production 注意事項

- VRM、FBX、音訊與大型專案素材建議透過物件儲存服務提供，不要提交進 Git。
- MediaPipe、MindAR 與 Three.js 目前會產生較大的前端 bundle；若要大量公開使用，建議按模式進行 dynamic import。
- Quest 測試至少覆蓋：首次授權、Session 中斷恢復、重新置中、角色朝向、手勢縮放與低記憶體情境。

