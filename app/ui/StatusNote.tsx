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
        <p className="note">
          {stage.label}
          <span className="note-bar">
            <span style={{ width: `${Math.round(stage.value * 100)}%` }} />
          </span>
        </p>
      )}
      {hint && <p className="note">{hint}</p>}
      {error && <p className="note is-error">{error}</p>}
    </>
  );
}
