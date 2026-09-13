interface Props {
  onFile: (file: File) => void;
  dragging: boolean;
}

export function Dropzone({ onFile, dragging }: Props) {
  return (
    <section className="card">
      <div className={dragging ? "drop is-hot" : "drop"}>
        <span className="drop-lead">声音转换成图像，还能转换回去</span>
        <span className="drop-sub">mp3, wav, flac, m4a, ogg, amr ↔ png, jpg, webp<br/>纯客户端，无服务器，不上传数据</span>
        <div className="drop-acts">
          <label className="drop-act">
            选文件
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
