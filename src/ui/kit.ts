import * as stylex from "@stylexjs/stylex";

export const tokens = stylex.create({
  app: {
    "--bg-warm":
      "radial-gradient(circle at 18% 12%, rgba(255, 196, 83, 0.3), transparent 44%), linear-gradient(180deg, #fff8ea 0%, #f8e6c4 100%)",
    "--ink": "#3d3427",
    "--soft": "#8a7d68",
    "--line": "rgba(61, 52, 39, 0.13)",
    "--glass": "rgba(255, 252, 245, 0.66)",
    "--glass-hover": "rgba(255, 252, 245, 0.85)",
    "--glass-line": "rgba(255, 255, 255, 0.6)",
    "--r-pill": "999px",
    "--font":
      'ui-rounded, -apple-system, "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", system-ui, sans-serif',
  },
  shell: {
    "--c-max": "1180px",
    "--c-eff": "min(100cqi, 160cqb)",
    "--c-vh": "1cqb",
    "--u": "min(calc(var(--c-eff) * 14 / 340), calc(14px + (var(--c-eff) - 340px) / 280), 16.5px)",
    "--fs-lead": "calc(0.9375 * var(--u))",
    "--fs-hi": "calc(0.75 * var(--u))",
    "--fs-lo": "calc(0.6875 * var(--u))",
    "--h-ctl": "calc(1.75 * var(--u))",
    "--r-md": "calc(0.75 * var(--u))",
    "--r-lg": "calc(1 * var(--u))",
    "--blur": "blur(calc(0.75 * var(--u))) saturate(1.2)",
    "--shadow-ctl": "0 calc(0.125 * var(--u)) calc(0.5 * var(--u)) rgba(61, 52, 39, 0.06)",
    "--shadow-hover": "0 calc(0.25 * var(--u)) calc(1 * var(--u)) rgba(61, 52, 39, 0.16)",
    "--shadow-card": "0 calc(0.5 * var(--u)) calc(1.5 * var(--u)) rgba(61, 52, 39, 0.07)",
  },
});

const GLASS = {
  borderWidth: "1px",
  borderStyle: "solid",
  borderColor: "var(--glass-line)",
  backgroundColor: "var(--glass)",
  backdropFilter: "var(--blur)",
} as const;

const SQUIRCLE = {
  cornerShape: { "@supports (corner-shape: squircle)": "squircle" },
} as const;

const FOCUS = (offset: string) =>
  ({
    outlineWidth: { ":focus-visible": offset },
    outlineStyle: { ":focus-visible": "solid" },
    outlineColor: { ":focus-visible": "rgba(147, 200, 234, 0.8)" },
    outlineOffset: { ":focus-visible": offset },
  }) as const;

const FOCUS_SM = FOCUS("0.125em");
const FOCUS_LG = FOCUS("0.1875em");

const HOVER = {
  backgroundColor: { default: null, "@media (hover: hover)": "var(--glass-hover)" },
  boxShadow: { default: null, "@media (hover: hover)": "var(--shadow-hover)" },
  transform: { default: null, "@media (hover: hover)": "scale(1.04)" },
} as const;

const PRESS = {
  transform: { ":active:not(:disabled)": "scale(1)" },
  boxShadow: { ":active:not(:disabled)": "var(--shadow-ctl)" },
  backgroundColor: { ":active:not(:disabled)": "var(--glass)" },
} as const;

const SIZED = {
  ...GLASS,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  height: "var(--h-ctl)",
  borderRadius: "var(--r-pill)",
  boxShadow: "var(--shadow-ctl)",
  color: "var(--ink)",
  fontFamily: "var(--font)",
  fontSize: "var(--fs-lo)",
  letterSpacing: "0.04em",
  lineHeight: 1,
  whiteSpace: "nowrap",
  fontVariantNumeric: "tabular-nums",
  transition: "transform 0.1s ease, box-shadow 0.16s ease, background-color 0.16s ease, color 0.16s ease",
  opacity: { ":disabled": 0.5 },
  cursor: { default: "pointer", ":disabled": "default" },
} as const;

export const kit = stylex.create({
  squircle: SQUIRCLE,
  focusSm: FOCUS_SM,
  card: {
    ...GLASS,
    display: "flex",
    flexDirection: "column",
    rowGap: "0.5em",
    padding: "1em",
    borderRadius: "var(--r-lg)",
    boxShadow: "var(--shadow-card)",
    containerType: "inline-size",
    ...SQUIRCLE,
  },
  act: {
    ...SIZED,
    ...HOVER,
    ...PRESS,
    ...FOCUS_LG,
    paddingBlock: 0,
    paddingInline: "1.125em",
  },
  chip: {
    ...SIZED,
    ...FOCUS_LG,
    paddingBlock: 0,
    paddingInline: "0.75em",
    minWidth: "2.5em",
  },
  chipHover: { ...HOVER, ...PRESS },
  chipOn: { ...PRESS, borderColor: "var(--ink)" },
  num: {
    ...SIZED,
    ...FOCUS_SM,
    paddingBlock: 0,
    paddingInline: "0.75em",
    columnGap: "0.375em",
    color: "var(--soft)",
    cursor: "text",
    backgroundColor: { default: "var(--glass)", ":focus-within": "var(--glass-hover)" },
  },
  numInput: {
    width: "3em",
    padding: 0,
    borderWidth: 0,
    backgroundColor: "transparent",
    color: "var(--ink)",
    fontFamily: "var(--font)",
    fontSize: "1em",
    letterSpacing: "0.04em",
    fontVariantNumeric: "tabular-nums",
    ...FOCUS_SM,
  },
  iconBtn: {
    ...SIZED,
    ...HOVER,
    ...PRESS,
    ...FOCUS_SM,
    flexShrink: 0,
    width: "var(--h-ctl)",
    paddingBlock: 0,
    paddingInline: 0,
    cornerShape: { "@supports (corner-shape: squircle)": "round" },
  },
  dropAct: {
    ...SIZED,
    ...HOVER,
    ...PRESS,
    ...FOCUS_LG,
    paddingBlock: 0,
    paddingInline: "1.75em",
    letterSpacing: "0.1em",
  },
  ico: {
    width: "1em",
    height: "1em",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  },
  dim: { color: "var(--soft)" },
});
