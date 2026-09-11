interface ImportMeta {
  readonly url: string;

  readonly hot: {
    data: { root?: import("react-dom/client").Root };
    dispose(callback: () => void): void;
  };
}
