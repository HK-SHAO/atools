import * as stylex from "@stylexjs/stylex";
import { kit } from "./kit";

const FENCE = "rgba(61, 52, 39, 0.3)";

const drop = stylex.create({
  zone: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    rowGap: "0.25em",
    paddingBlock: "1.75em",
    paddingInline: "1em",
    borderWidth: "1px",
    borderStyle: "dashed",
    borderColor: { default: "var(--line)", "@media (hover: hover)": FENCE },
    borderRadius: "var(--r-md)",
    textAlign: "center",
    cursor: "pointer",
    transition: "border-color 0.18s ease",
  },
  hot: { borderColor: FENCE },
  lead: { fontSize: "var(--fs-lead)", letterSpacing: "0.04em" },
  sub: { color: "var(--soft)", fontSize: "var(--fs-lo)", letterSpacing: "0.04em" },
  acts: {
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "center",
    columnGap: "0.25em",
    marginTop: "1em",
  },
});

interface Props {
  onFile: (file: File) => void;
  dragging: boolean;
}

export function Dropzone({ onFile, dragging }: Props) {
  return (
    <section {...stylex.props(kit.card)}>
      <div {...stylex.props(kit.squircle, drop.zone, dragging && drop.hot)}>
        <span {...stylex.props(drop.lead)}>拖进一段音频，或者一张图</span>
        <span {...stylex.props(drop.sub)}>mp3, wav, flac, m4a, ogg, amr ↔ png, jpg, webp</span>
        <div {...stylex.props(drop.acts)}>
          <label data-el="drop-act" {...stylex.props(kit.dropAct)}>
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
