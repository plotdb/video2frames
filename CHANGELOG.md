## v0.0.2

 - `size: 0` 照影片原尺寸輸出 ( 長方形 )。原本一律畫成 max(w, h) 的正方形、上下或左右補白，
   與文件不符；長寬差是奇數時還會畫在半像素上，整張變糊


## v0.0.1

init release

 - `webcodecs` / `ffmpeg` / `video` 三種抽格策略，可指定或自動退讓
 - Web Worker 可用（`video` 策略除外，它需要 `<video>` 元素）
