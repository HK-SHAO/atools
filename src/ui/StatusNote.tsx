import * as stylex from "@stylexjs/stylex";
import { note } from "./styles";
import type { Stage } from "./useStudio";

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
      {error && <p {...stylex.props(note.line, note.error)}>{error}</p>}
    </>
  );
}
