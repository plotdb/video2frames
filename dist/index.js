/**
 * Video2Frames — 影片抽格，瀏覽器端
 *
 * 從一段影片取出指定時間點的 ImageData。解碼手段有三種，能力差很多，
 * 所以做成可指定、也可以自動退讓的策略鏈：
 *
 *   webcodecs  VideoDecoder + mp4box.js 拆容器。最快最準，一次 decode 整段照序吐格。
 *              需要瀏覽器支援 WebCodecs，以及一份 mp4box.js。
 *   ffmpeg     ffmpeg-wasm 軟體解碼。跟瀏覽器有沒有內建 codec 完全無關，
 *              是最後的保命符；但 core wasm 很大，所以只在呼叫端明確給了網址時才走。
 *   video      <video> 逐格 seek + drawImage。到處都能跑，但慢、依賴瀏覽器的 codec，
 *              而且某些環境 ( 沒有 h264 解碼器 ) 會無聲卡住，只能靠逾時收場。
 *
 * strategy 沒指定時依 webcodecs > ffmpeg > video 往下試。
 * 「能不能用」與「實際跑起來會不會壞」是兩回事 —— 某個策略宣稱可用但中途失敗時，
 * 仍然會退到下一個，所以不必擔心 isConfigSupported 說謊。
 *
 * 用法:
 *   const v2f = new Video2Frames({ mp4boxUrl: '/assets/lib/mp4box/main/mp4box.all.min.js' });
 *   const r = await v2f.extract(blob, { count: 24, size: 512 });
 *   // r = { frames: [ImageData], duration, width, height, strategy }
 *
 * document 不存在時 ( Web Worker ) 自動改用 OffscreenCanvas；
 * 但 video 策略需要 <video> 元素，在 worker 裡不可用，會被自動跳過。
 */

const STRATEGIES = ['webcodecs', 'ffmpeg', 'video'];

const DEFAULTS = {
  strategy: null,        // null = auto
  mp4boxUrl: null,       // webcodecs 需要；沒給就試 globalThis.MP4Box
  ffmpegUrl: null,       // { coreURL, wasmURL } 或 classURL 字串；沒給就跳過 ffmpeg
  videoTimeout: 20000,   // <video> 多久沒 loadeddata 就當作解不了
  seekTimeout: 8000,
  background: '#ffffff',
};

class Video2Frames {
  constructor(options = {}) {
    this.options = Object.assign({}, DEFAULTS, options);
    this._mp4box = null;
  }

  /**
   * 抽格。
   * @param {Blob|string} source - 影片 Blob 或 URL
   * @param {Object} opt
   * @param {number} [opt.count]      - 平均取幾格（與 times 二擇一）
   * @param {number[]|Function} [opt.times] - 指定時間點（秒），或 (duration) => number[]
   * @param {number} [opt.size=0]     - 輸出正方形邊長；0 = 用影片原尺寸
   * @param {number} [opt.smooth=0]   - 抽格時的 blur 半徑（px）
   * @param {Function} [opt.onProgress] - (done, total, strategy)
   * @returns {Promise<{frames: ImageData[], duration, width, height, strategy}>}
   */
  async extract(source, opt = {}) {
    const order = this._order();
    const errors = [];

    for (const name of order) {
      const fn = this['_' + name];
      if (!fn) continue;
      let usable;
      try { usable = await this['_can_' + name](); }
      catch (e) { usable = false; }
      if (!usable) { errors.push(`${name}: unavailable`); continue; }

      try {
        return await fn.call(this, source, opt);
      } catch (e) {
        // 宣稱可用但實際跑壞 —— 退到下一個策略，不要讓整條流程死在這裡
        errors.push(`${name}: ${(e && e.message) || e}`);
        if (this.options.strategy) throw e;
      }
    }
    throw new Error('cannot extract frames (' + errors.join('; ') + ')');
  }

  /** 只讀影片基本資訊，不解格。 */
  async probe(source) {
    const r = await this.extract(source, { times: [0], size: 0 });
    r.frames.length = 0;
    return r;
  }

  _order() {
    const s = this.options.strategy;
    if (!s) return STRATEGIES.slice();
    if (STRATEGIES.indexOf(s) < 0) throw new Error('unknown strategy: ' + s);
    return [s];
  }

  // ── 共用 ────────────────────────────────────────────────────────────────

  /**
   * 依 count / times 算出要抽的時間點。
   * times 可以是陣列，也可以是 (duration) => number[] —— 影片長度要解開容器才知道，
   * 給函式就不必為了算時間點先 probe 一次。
   */
  _times(duration, opt) {
    if (typeof opt.times === 'function') return opt.times(duration).slice();
    if (opt.times && opt.times.length) return opt.times.slice();
    const n = Math.max(1, opt.count || 1);
    const out = [];
    for (let i = 0; i < n; i++) out.push(i * duration / n);
    return out;
  }

  _canvas(size) {
    if (typeof document !== 'undefined') {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      return c;
    }
    return new OffscreenCanvas(size, size);
  }

  /** 把一張影像置中畫進正方形畫布，回傳 ImageData。 */
  _draw(src, srcW, srcH, opt) {
    const size = opt.size || Math.max(srcW, srcH);
    const c = this._canvas(size);
    const ctx = c.getContext('2d');
    ctx.filter = 'none';
    ctx.fillStyle = this.options.background;
    ctx.fillRect(0, 0, size, size);
    if (opt.smooth > 0) ctx.filter = `blur(${opt.smooth}px)`;
    const scale = Math.min(size / srcW, size / srcH);
    const w = srcW * scale;
    const h = srcH * scale;
    ctx.drawImage(src, (size - w) / 2, (size - h) / 2, w, h);
    ctx.filter = 'none';
    return ctx.getImageData(0, 0, size, size);
  }

  async _blob(source) {
    if (typeof source === 'string') {
      const res = await fetch(source);
      if (!res.ok) throw new Error('cannot fetch video (' + res.status + ')');
      return res.blob();
    }
    return source;
  }

  _load(url) {
    if (typeof importScripts === 'function') { importScripts(url); return Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('cannot load ' + url));
      s.src = url;
      document.head.appendChild(s);
    });
  }

  // ── webcodecs ───────────────────────────────────────────────────────────

  async _can_webcodecs() {
    if (typeof VideoDecoder === 'undefined') return false;
    if (globalThis.MP4Box) { this._mp4box = globalThis.MP4Box; return true; }
    if (!this.options.mp4boxUrl) return false;
    await this._load(this.options.mp4boxUrl);
    this._mp4box = globalThis.MP4Box;
    return !!this._mp4box;
  }

  /** mp4box 把容器拆成 track info + encoded samples。 */
  _demux(buffer) {
    const MP4Box = this._mp4box;
    return new Promise((resolve, reject) => {
      const file = MP4Box.createFile();
      const samples = [];
      let info = null;

      file.onError = e => reject(new Error('mp4 demux failed: ' + e));
      file.onReady = i => {
        info = i;
        const track = i.videoTracks && i.videoTracks[0];
        if (!track) return reject(new Error('no video track'));
        file.setExtractionOptions(track.id, null, { nbSamples: Infinity });
        file.start();
      };
      file.onSamples = (id, user, list) => {
        for (const s of list) samples.push(s);
      };

      buffer.fileStart = 0;
      file.appendBuffer(buffer);
      file.flush();

      const track = info && info.videoTracks && info.videoTracks[0];
      if (!track) return reject(new Error('mp4 has no video track'));
      resolve({ file, info, track, samples });
    });
  }

  /** 從 avcC / hvcC box 取出 decoder description。 */
  _description(file, track) {
    const entry = file.getTrackById(track.id).mdia.minf.stbl.stsd.entries[0];
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (!box) return null;
    const DS = this._mp4box.DataStream || globalThis.DataStream;
    const stream = new DS(undefined, 0, DS.BIG_ENDIAN);
    box.write(stream);
    return new Uint8Array(stream.buffer, 8); // 去掉 box header
  }

  async _webcodecs(source, opt) {
    const blob = await this._blob(source);
    const buffer = await blob.arrayBuffer();
    const { file, track, samples } = await this._demux(buffer);

    const duration = track.duration / track.timescale;
    const width = track.track_width || track.video.width;
    const height = track.track_height || track.video.height;
    const times = this._times(duration, opt);

    const description = this._description(file, track);
    const config = { codec: track.codec, codedWidth: width, codedHeight: height };
    if (description) config.description = description;

    const support = await VideoDecoder.isConfigSupported(config);
    if (!support.supported) throw new Error('codec not supported: ' + track.codec);

    // 目標時間 -> 目前最接近的那一格.
    // VideoFrame 是 GPU 資源, 生命週期很麻煩 ( 同一格可能同時是好幾個目標的最佳解,
    // 之後又被更近的格取代 ), 所以一被選上就立刻畫成 ImageData 再 close,
    // 不留任何 VideoFrame 過夜. 多畫的次數頂多是目標數的兩三倍, 不是全部 49 格.
    const picked = times.map(() => null);
    const best = times.map(() => Infinity);
    let decoded = 0;

    await new Promise((resolve, reject) => {
      const decoder = new VideoDecoder({
        output: frame => {
          const t = frame.timestamp / 1e6;
          let want = false;
          for (let i = 0; i < times.length; i++) {
            if (Math.abs(t - times[i]) < best[i]) { want = true; break; }
          }
          if (want) {
            const img = this._draw(
              frame, frame.displayWidth || width, frame.displayHeight || height, opt);
            for (let i = 0; i < times.length; i++) {
              const d = Math.abs(t - times[i]);
              if (d < best[i]) { best[i] = d; picked[i] = img; }
            }
          }
          frame.close();
          decoded++;
          if (opt.onProgress) opt.onProgress(decoded, samples.length, 'webcodecs');
        },
        error: e => reject(e),
      });
      decoder.configure(config);
      for (const s of samples) {
        decoder.decode(new EncodedVideoChunk({
          type: s.is_sync ? 'key' : 'delta',
          timestamp: (s.cts / s.timescale) * 1e6,
          duration: (s.duration / s.timescale) * 1e6,
          data: s.data,
        }));
      }
      decoder.flush().then(() => { decoder.close(); resolve(); }, reject);
    });

    // 目標比來源格還密時, 同一格會被多個 slot 選中 -- 重複的要複製一份,
    // 否則呼叫端 transfer 其中一個的 buffer 就會把另一個也弄壞.
    const seen = new Set();
    const frames = picked.map(img => {
      if (!img) throw new Error('decoder produced no frame');
      if (!seen.has(img)) { seen.add(img); return img; }
      return new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
    });
    return { frames, duration, width, height, strategy: 'webcodecs' };
  }

  // ── ffmpeg-wasm ─────────────────────────────────────────────────────────
  // 只在呼叫端明確給了 ffmpegUrl 時才走 —— core wasm 動輒 25MB，不該是預設。
  // 對應 @ffmpeg/ffmpeg 0.12 的 API。

  async _can_ffmpeg() {
    return !!this.options.ffmpegUrl;
  }

  async _ffmpeg(source, opt) {
    const cfg = this.options.ffmpegUrl;
    const urls = typeof cfg === 'string' ? { classURL: cfg } : cfg;
    if (urls.classURL && !globalThis.FFmpegWASM) await this._load(urls.classURL);
    const NS = globalThis.FFmpegWASM;
    if (!NS || !NS.FFmpeg) throw new Error('ffmpeg-wasm not available');

    const ff = new NS.FFmpeg();
    await ff.load({ coreURL: urls.coreURL, wasmURL: urls.wasmURL });

    const blob = await this._blob(source);
    await ff.writeFile('in.mp4', new Uint8Array(await blob.arrayBuffer()));

    // 先問尺寸與長度：ffmpeg-wasm 沒有 probe API，用一次解碼把 log 撈出來
    let duration = 0, width = 0, height = 0;
    ff.on('log', ({ message }) => {
      let m = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(message);
      if (m) duration = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
      m = /,\s*(\d+)x(\d+)[\s,]/.exec(message);
      if (m && !width) { width = +m[1]; height = +m[2]; }
    });
    await ff.exec(['-i', 'in.mp4', '-f', 'null', '-']);
    if (!duration) throw new Error('ffmpeg could not read the video');

    const times = this._times(duration, opt);
    const frames = [];
    for (let i = 0; i < times.length; i++) {
      const name = `f${i}.png`;
      await ff.exec(['-ss', String(times[i]), '-i', 'in.mp4', '-frames:v', '1', name]);
      const png = await ff.readFile(name);
      const bmp = await createImageBitmap(new Blob([png], { type: 'image/png' }));
      frames.push(this._draw(bmp, bmp.width, bmp.height, opt));
      bmp.close();
      await ff.deleteFile(name);
      if (opt.onProgress) opt.onProgress(i + 1, times.length, 'ffmpeg');
    }
    await ff.deleteFile('in.mp4');
    ff.terminate();
    return { frames, duration, width, height, strategy: 'ffmpeg' };
  }

  // ── <video> seek ────────────────────────────────────────────────────────

  async _can_video() {
    return typeof document !== 'undefined' && typeof HTMLVideoElement !== 'undefined';
  }

  _video(source, opt) {
    const self = this;
    return new Promise((resolve, reject) => {
      const v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      let settled = false;

      // 有些環境沒有 h264 解碼器，這時 <video> 會一直停在 readyState 0 而不是報錯，
      // 所以一定要自己設逾時，否則整條流程會無聲卡住。
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('this browser cannot decode the video'));
      }, self.options.videoTimeout);

      v.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error('cannot load video'));
      };

      v.onloadeddata = async () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          const duration = v.duration || 0;
          const times = self._times(duration, opt);
          const frames = [];
          for (let i = 0; i < times.length; i++) {
            // 不要 seek 到正好結尾，有些解碼器會停在前一格
            await self._seek(v, Math.min(times[i], Math.max(0, duration - 0.02)));
            frames.push(self._draw(v, v.videoWidth, v.videoHeight, opt));
            if (opt.onProgress) opt.onProgress(i + 1, times.length, 'video');
          }
          resolve({
            frames, duration,
            width: v.videoWidth, height: v.videoHeight,
            strategy: 'video',
          });
        } catch (e) { reject(e); }
        finally { URL.revokeObjectURL(v.src); }
      };

      Promise.resolve(typeof source === 'string' ? source : URL.createObjectURL(source))
        .then(url => { v.src = url; }, reject);
    });
  }

  _seek(video, t) {
    const timeout = this.options.seekTimeout;
    return new Promise((resolve, reject) => {
      const done = () => { video.removeEventListener('seeked', done); clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => {
        video.removeEventListener('seeked', done);
        reject(new Error('seek timeout at ' + t));
      }, timeout);
      video.addEventListener('seeked', done);
      video.currentTime = t;
    });
  }
}

Video2Frames.STRATEGIES = STRATEGIES;

if (typeof module !== 'undefined' && module.exports) {
  module.exports = Video2Frames;
}
