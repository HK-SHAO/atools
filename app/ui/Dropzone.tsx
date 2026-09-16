import { t } from "../lib/i18n";

interface Props {
  onFile: (file: File) => void;
  dragging: boolean;
}

export function Dropzone({ onFile, dragging }: Props) {
  return (
    <section className="card">
      <div className={dragging ? "drop is-hot" : "drop"}>
        <span className="drop-lead">{t("dropLead")}</span>
        <span className="drop-sub">
          {t("dropFormats")}
          <br />
          {t("dropPrivacy")}
        </span>
        <div className="drop-acts">
          <label className="drop-act">
            {t("pickFile")}
            <input
              id="source-file"
              name="source-file"
              type="file"
              accept="audio/*,image/*"
              hidden
              onChange={e => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (file) onFile(file);
              }}
            />
          </label>
        </div>
      </div>
    </section>
  );
}
