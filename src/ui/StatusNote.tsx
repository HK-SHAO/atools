import * as stylex from "@stylexjs/stylex";
import type { Stage } from "./useStudio";

const note = stylex.create({
  line: {
    display: "flex",
    alignItems: "center",
    gap: "0.75em",
    margin: 0,
    fontSize: "var(--fs-lo)",
    letterSpacing: "0.04em",
    color: "var(--soft)",
  },
  error: { color: "#96411f" },
  bar: {
    flex: 1,
    height: "0.1875em",
    borderRadius: "var(--r-pill)",
    backgroundColor: "rgba(61, 52, 39, 0.1)",
    overflow: "hidden",
  },
  fill: (pct: number) => ({
    display: "block",
    height: "100%",
    backgroundColor: "rgba(61, 52, 39, 0.42)",
    transition: "width 0.12s linear",
    width: pct + "%",
  }),
});

interface Props {
  stage: Stage;
  hint?: string | null;
  error?: string | null;
}

export function StatusNote({ stage, hint, error }: Props) {
  return (
    <>
      {stage && (
        <p {...stylex.props(note.line)}>
          {stage.label}
          <span {...stylex.props(note.bar)}>
            <span {...stylex.props(note.fill(Math.round(stage.value * 100)))} />
          </span>
        </p>
      )}
      {hint && <p {...stylex.props(note.line)}>{hint}</p>}
      {error && (
        <p {...stylex.props(note.line, note.error)}>
          {error}
        </p>
      )}
    </>
  );
}
