import { useRef } from "react";
import { Fold } from "./Fold";

const REPO = "https://github.com/HK-SHAO/atools";

export function About() {
  const ref = useRef<HTMLDialogElement>(null);

  return (
    <>
      <button type="button" className="head-btn" onClick={() => ref.current?.showModal()}>
        关于
      </button>
      <dialog
        ref={ref}
        className="about"
        aria-labelledby="about-title"
        onClick={e => {
          // 点遮罩关掉。标题、正文与页脚铺满内容区，所以这只会在真点到遮罩时命中。
          if (e.target === ref.current) ref.current.close();
        }}
      >
        <h2 id="about-title">声音可以是一张图</h2>
        <div className="about-body">
          <p>拖入音频，得到频谱图；把图拖回来，听见原来的声音。</p>
          <p>它是一张普通图片，能转发、压缩、存进相册。</p>
          <p>读回来的质量取决于它经历过什么。</p>

          <Fold label="技术">
            <p>内核 MoonBit，编译为 Wasm，浏览器直接调用。</p>
            <p>界面 React 与 TypeScript，构建 Bun；产物是纯静态页面。</p>
            <p>原理是短时傅里叶变换。紧凑模式用 PGHI 与 RTISI-LA 重建相位，可逆模式把相位写进图片。</p>
          </Fold>

          <Fold label="实测">
            <p>30 秒音频的编码与还原 172 ms，约 170 倍实时。</p>
            <p>STFT 与 librosa 0.11.0 的最差相对误差 6.1e-16，FFT 与朴素 DFT 在 1e-12 以内。</p>
          </Fold>
        </div>

        <form method="dialog" className="about-foot">
          <a href={REPO} target="_blank" rel="noreferrer">
            源代码
          </a>
          <button type="submit" className="act">
            关闭
          </button>
        </form>
      </dialog>
    </>
  );
}
