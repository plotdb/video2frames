# @plotdb/video2frames

從影片取出指定時間點的 `ImageData`，在瀏覽器裡。

解碼手段有三種，能力與代價差很多，所以做成可指定、也可以自動退讓的策略鏈。

| strategy | 怎麼解 | 需要什麼 | 備註 |
|---|---|---|---|
| `webcodecs` | `VideoDecoder` + mp4box.js 拆容器 | WebCodecs、一份 mp4box.js | 最快最準，一次 decode 整段照序吐格 |
| `ffmpeg` | ffmpeg-wasm 軟體解碼 | 呼叫端提供 core 網址 | 跟瀏覽器有沒有內建 codec 無關，但 wasm 很大 |
| `video` | `<video>` 逐格 seek + `drawImage` | `<video>` 元素 | 到處能跑，但慢，且某些環境會無聲卡住 |

沒指定 `strategy` 時依 `webcodecs` → `ffmpeg` → `video` 往下試。

**「能不能用」與「跑起來會不會壞」是兩回事。** 某個策略宣稱可用但中途失敗時仍會退到下一個 ——
`VideoDecoder.isConfigSupported()` 回 `true` 不保證實際解得出來，`<video>` 的 `canPlayType()`
也一樣，所以不能只靠事前偵測。

`ffmpeg` 預設是關的：core wasm 動輒 25MB，不該讓每個使用者都付這個代價。給了
`ffmpegUrl` 才會進入候選，適合當作「少數裝置真的沒有 h264 解碼器」的保命符。


## 安裝

    npm install @plotdb/video2frames


## 使用

    <script src="path-to/index.min.js"></script>

    const v2f = new Video2Frames({
      mp4boxUrl: '/assets/lib/mp4box/main/mp4box.all.min.js'
    });

    const r = await v2f.extract(blob, { count: 24, size: 512, smooth: 0.6 });
    // r = { frames: [ImageData, ...], duration, width, height, strategy }


## Constructor Options

 - `strategy`：`'webcodecs'` | `'ffmpeg'` | `'video'`。省略 = 自動依序退讓。
   明確指定時不會退讓，失敗就直接拋錯。
 - `mp4boxUrl`：mp4box.js 的網址。`webcodecs` 需要；若 `globalThis.MP4Box` 已存在則不必給。
 - `ffmpegUrl`：`@ffmpeg/ffmpeg` 0.12 的位置。字串 = `classURL`，或給
   `{classURL, coreURL, wasmURL}`。沒給就跳過 `ffmpeg` 策略。
 - `videoTimeout`（預設 20000）：`<video>` 多久沒 `loadeddata` 就當作解不了。
   **這個逾時是必要的** —— 沒有 h264 解碼器時 `<video>` 會停在 `readyState 0` 而不報錯。
 - `seekTimeout`（預設 8000）：單次 seek 的逾時。
 - `background`（預設 `'#ffffff'`）：畫布底色。


## API

 - `extract(source, options)` → `Promise<{frames, duration, width, height, strategy}>`
   - `source`：影片 `Blob` 或 URL 字串
   - `options.count`：平均取幾格（與 `times` 二擇一）
   - `options.times`：指定時間點陣列（秒），或 `(duration) => number[]`。
     影片長度要解開容器才知道，給函式就不必為了算時間點先 `probe()` 一次
   - `options.size`：輸出正方形邊長；`0` = 用影片原尺寸
   - `options.smooth`：抽格時的 blur 半徑（px）。h264 在平塗邊緣留下的噪點
     會讓後續的向量化描出鋸齒，輕微模糊可以壓掉
   - `options.onProgress(done, total, strategy)`
 - `probe(source)` → 同上但不留 frames，只要基本資訊


## Web Worker

`document` 不存在時自動改用 `OffscreenCanvas`，所以 `webcodecs` 與 `ffmpeg` 兩個策略
在 worker 裡都能跑。`video` 策略需要 `<video>` 元素，在 worker 裡會被自動跳過。

    importScripts('/assets/lib/@plotdb/video2frames/main/index.min.js');
    const v2f = new Video2Frames({ mp4boxUrl: '...' });


## 為什麼不只用 `<video>`

逐格 `seek` + `drawImage` 看起來最簡單，但有三個真實踩過的坑：

1. **沒有 h264 解碼器時它不報錯，只是永遠不 ready。** `networkState` 停在 2、
   `readyState` 停在 0，沒有 `error` 事件 —— 只能靠逾時。
2. **慢。** 每格要等一次 `seeked`，而且 seek 到正好結尾時有些解碼器會停在前一格。
3. **`canPlayType()` 會說謊。** 實際遇過回報 `"probably"` 但完全解不出來的環境，
   而同一個瀏覽器的 `VideoDecoder.isConfigSupported()` 是正常的。

`webcodecs` 沒有這些問題：一次 decode 整段、照時間序吐 frame，解碼走原生路徑。
代價只是要多帶一份 mp4box.js（約 200KB）來拆容器 —— WebCodecs 只管解碼，不管容器。
