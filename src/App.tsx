import { CREDIT_AUTHOR, CREDIT_NAME } from "./credit";
import { Dropzone } from "./ui/Dropzone";
import { StatusNote } from "./ui/StatusNote";
import { useDragDrop } from "./ui/useDragDrop";
import { useStudio } from "./ui/useStudio";
import { Workbench } from "./ui/Workbench";

export function App() {
  const studio = useStudio();
  const { dragging, handlers } = useDragDrop(studio.open);
  const { source, job } = studio;
  const live = source !== null && job !== null;

  return (
    <div className={dragging ? "app is-dragging" : "app"} {...handlers}>
      <div className="shell">
        <header className="head">
          <h1>频谱 SPECTRUM</h1>
          <p>声音 ↔ 图像</p>
          <a
            className="head-link"
            href="https://github.com/HK-SHAO/atools"
            target="_blank"
            rel="noreferrer"
          >
            源代码
          </a>
        </header>

        {source && job ? (
          <Workbench
            spec={job.spec}
            pcm={job.pcm}
            png={job.png}
            name={source.name}
            srcSr={source.sr}
            mode={studio.mode}
            enc={studio.enc}
            onEnc={studio.setEnc}
            onTrim={studio.trim}
            onRefine={studio.refine}
            stage={studio.stage}
            hint={studio.hint}
            error={studio.error}
          />
        ) : (
          <Dropzone onFile={studio.open} />
        )}

        {!live && (
          <StatusNote stage={studio.stage} hint={studio.hint} error={studio.error} />
        )}

        <footer className="foot">
          {source && (
            <button type="button" className="act" onClick={studio.clear}>
              清空
            </button>
          )}
          <button type="button" className="act" onClick={studio.demo}>
            演示
          </button>
          <span className="credit">
            {CREDIT_NAME} · created by{" "}
            <a href={CREDIT_AUTHOR.url} target="_blank" rel="noreferrer">
              {CREDIT_AUTHOR.name}
            </a>
          </span>
        </footer>
      </div>
    </div>
  );
}

export default App;
