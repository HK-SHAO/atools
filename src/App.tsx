import * as stylex from "@stylexjs/stylex";
import { CREDIT_AUTHOR, CREDIT_NAME } from "./credit";
import { Dropzone } from "./ui/Dropzone";
import { kit, tokens } from "./ui/kit";
import { StatusNote } from "./ui/StatusNote";
import { useDragDrop } from "./ui/useDragDrop";
import { useStudio } from "./ui/useStudio";
import { Workbench } from "./ui/Workbench";

const dim = { color: "var(--soft)" } as const;

const LINK = {
  ...dim,
  fontSize: "var(--fs-lo)",
  letterSpacing: "0.04em",
  textDecorationLine: "underline",
  textDecorationColor: "var(--line)",
  textUnderlineOffset: "2px",
  transition: "color 0.15s",
  color: { default: "var(--soft)", ":hover": "var(--ink)" },
} as const;

const layout = stylex.create({
  app: {
    position: "relative",
    height: "100%",
    overflowY: "auto",
    overflowX: "hidden",
    isolation: "isolate",
    containerType: "size",
    backgroundColor: "var(--bg-warm)",
    color: "var(--ink)",
    fontFamily: "var(--font)",
    lineHeight: 1.7,
    colorScheme: "light",
    WebkitFontSmoothing: "antialiased",
    WebkitTapHighlightColor: "transparent",
    textAutospace: "normal",
  },
  shell: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    rowGap: "0.75em",
    width: "100%",
    maxWidth: "var(--c-max)",
    marginInline: "auto",
    paddingTop: "max(1.25em, env(safe-area-inset-top, 0px))",
    paddingBottom: "max(1.5em, env(safe-area-inset-bottom, 0px))",
    paddingLeft: "max(1em, env(safe-area-inset-left, 0px))",
    paddingRight: "max(1em, env(safe-area-inset-right, 0px))",
    fontSize: "var(--u)",
  },
  head: { display: "flex", alignItems: "baseline", columnGap: "0.5em" },
  title: { margin: 0, fontSize: "var(--fs-lead)", fontWeight: 600, letterSpacing: "0.22em" },
  subtitle: { ...dim, margin: 0, fontSize: "var(--fs-lo)", letterSpacing: "0.1em" },
  headLink: { ...LINK, marginLeft: "auto" },
  foot: { display: "flex", flexWrap: "wrap", alignItems: "center", columnGap: "0.25em" },
  credit: { ...dim, marginLeft: "auto", fontSize: "var(--fs-lo)", letterSpacing: "0.04em" },
  creditLink: { ...LINK, color: "inherit", fontSize: "inherit", letterSpacing: "inherit" },
});

export function App() {
  const studio = useStudio();
  const { dragging, handlers } = useDragDrop(studio.open);
  const { source, job } = studio;
  const live = source !== null && job !== null;

  return (
    <div data-el="app" {...handlers} {...stylex.props(tokens.app, layout.app)}>
      <div data-el="shell" {...stylex.props(tokens.shell, layout.shell)}>
        <header {...stylex.props(layout.head)}>
          <h1 data-el="title" {...stylex.props(layout.title)}>
            频谱 SPECTRUM
          </h1>
          <p {...stylex.props(layout.subtitle)}>声音 ↔ 图像</p>
          <a
            {...stylex.props(layout.headLink)}
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
          <Dropzone onFile={studio.open} dragging={dragging} />
        )}

        {!live && <StatusNote stage={studio.stage} hint={studio.hint} error={studio.error} />}

        <footer {...stylex.props(layout.foot)}>
          {source && (
            <button type="button" {...stylex.props(kit.act)} onClick={studio.clear}>
              清空
            </button>
          )}
          <button type="button" {...stylex.props(kit.act)} onClick={studio.demo}>
            演示
          </button>
          <span {...stylex.props(layout.credit)}>
            {CREDIT_NAME} · created by{" "}
            <a
              {...stylex.props(layout.creditLink)}
              href={CREDIT_AUTHOR.url}
              target="_blank"
              rel="noreferrer"
            >
              {CREDIT_AUTHOR.name}
            </a>
          </span>
        </footer>
      </div>
    </div>
  );
}

export default App;
