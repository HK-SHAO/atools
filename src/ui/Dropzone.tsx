interface Props {
  onFile: (file: File) => void;
  dragging: boolean;
}

export function Dropzone({ onFile, dragging }: Props) {
  return (
    <section className="card">
      <div className={dragging ? "drop is-hot" : "drop"}>
        <span className="drop-lead">拖进一段音频，或者一张图</span>
        <span className="drop-sub">mp3, wav, flac, m4a, ogg, amr ↔ png, jpg, webp</span>
        <div className="drop-acts">
          <label className="drop-act">
            选文件
            <input
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
