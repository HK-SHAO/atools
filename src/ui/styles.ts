import * as stylex from "@stylexjs/stylex";

export const note = stylex.create({
  line: {
    display: "flex",
    alignItems: "center",
    gap: "0.75em",
    margin: 0,
    fontSize: "var(--fs-lo)",
    letterSpacing: "0.04em",
    color: "var(--soft)",
  },
  error: {
    color: "#96411f",
  },
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

export const dim = stylex.create({
  text: {
    color: "var(--soft)",
  },
});

export const tick = stylex.create({
  text: {
    fontSize: "var(--fs-lo)",
    letterSpacing: "0.1em",
  },
});
