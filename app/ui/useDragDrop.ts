import { useMemo, useState, type DragEvent } from "react";

interface Handlers {
  onDragOver: (e: DragEvent<HTMLDivElement>) => void;
  onDragLeave: (e: DragEvent<HTMLDivElement>) => void;
  onDrop: (e: DragEvent<HTMLDivElement>) => void;
}

export function useDragDrop(
  onFile: (file: File) => void,
): { dragging: boolean; handlers: Handlers } {
  const [dragging, setDragging] = useState(false);

  const handlers = useMemo<Handlers>(
    () => ({
      onDragOver: e => {
        e.preventDefault();
        setDragging(true);
      },
      onDragLeave: e => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      },
      onDrop: e => {
        e.preventDefault();
        setDragging(false);
        const file = e.dataTransfer.files[0];
        if (file) onFile(file);
      },
    }),
    [onFile],
  );

  return { dragging, handlers };
}
