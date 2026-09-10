import { createStylexBunPlugin } from "@stylexjs/unplugin/bun";

export default createStylexBunPlugin({
  useCSSLayers: false,
  bunDevCssOutput: ".cache/stylex.dev.css",
});
