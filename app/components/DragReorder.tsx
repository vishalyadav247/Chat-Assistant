import { useState } from "react";

// Shared HTML5 drag-and-drop reorder for flat client-side lists (design
// faq.png pattern — drag handles instead of up/down buttons). Drag starts ONLY
// from the handle (rows stay scrollable/selectable); rows are drop targets.
// The FAQ tree has its own two-level implementation in FaqManager; this hook
// covers simple arrays such as chatbox starter questions and contact methods.

/** Move one item of an array from `from` to `to` (both 0-based). */
export function arrayMove<T>(items: T[], from: number, to: number): T[] {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

export function useDragReorder(onMove: (from: number, to: number) => void, enabled = true) {
  const [from, setFrom] = useState<number | null>(null);
  const [hint, setHint] = useState<{ index: number; edge: "before" | "after" } | null>(null);

  const clear = () => {
    setFrom(null);
    setHint(null);
  };

  const edgeFor = (e: React.DragEvent<HTMLElement>): "before" | "after" => {
    const rect = e.currentTarget.getBoundingClientRect();
    return e.clientY < rect.top + rect.height / 2 ? "before" : "after";
  };

  /** Spread onto the DragHandle (via its `drag` prop) — initiates the drag. */
  const handleProps = (index: number) => ({
    draggable: enabled,
    onDragStart: (e: React.DragEvent<HTMLElement>) => {
      setFrom(index);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(index));
    },
    onDragEnd: clear,
  });

  /** Spread onto each row's wrapper element — the drop target. */
  const rowProps = (index: number) => ({
    onDragOver: (e: React.DragEvent<HTMLElement>) => {
      if (from === null || from === index) return;
      e.preventDefault();
      setHint({ index, edge: edgeFor(e) });
    },
    onDragLeave: () => setHint((h) => (h?.index === index ? null : h)),
    onDrop: (e: React.DragEvent<HTMLElement>) => {
      e.preventDefault();
      if (from !== null && from !== index) {
        let to = edgeFor(e) === "before" ? index : index + 1;
        if (from < to) to -= 1; // removing the dragged row shifts the target
        if (to !== from) onMove(from, to);
      }
      clear();
    },
    style: {
      opacity: from === index ? 0.4 : 1,
      transition: "box-shadow .15s ease, opacity .15s ease",
      boxShadow:
        hint?.index === index
          ? `inset 0 ${hint.edge === "before" ? "2px" : "-2px"} 0 0 var(--s-color-border-focus, #005bd3)`
          : undefined,
    } as React.CSSProperties,
  });

  return { handleProps, rowProps };
}

export interface DragHandleProps {
  draggable: boolean;
  onDragStart: (e: React.DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
}

/** Drag affordance: grab cursor + ArrowUp/ArrowDown keyboard fallback. */
export function DragHandle(props: {
  label: string;
  drag: DragHandleProps;
  onKeyMove: (direction: "up" | "down") => void;
}) {
  const enabled = props.drag.draggable;
  return (
    <button
      type="button"
      aria-label={`${props.label} — drag, or press arrow up/down`}
      disabled={!enabled}
      draggable={props.drag.draggable}
      onDragStart={props.drag.onDragStart}
      onDragEnd={props.drag.onDragEnd}
      onKeyDown={(e) => {
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          props.onKeyMove(e.key === "ArrowUp" ? "up" : "down");
        }
      }}
      style={{
        border: "none",
        background: "none",
        padding: "0 2px",
        display: "inline-flex",
        alignItems: "center",
        cursor: enabled ? "grab" : "default",
        color: "var(--s-color-text-secondary, #8a8a8f)",
        opacity: enabled ? 1 : 0.4,
        touchAction: "none",
      }}
    >
      <s-icon type="drag-handle" size="small" />
    </button>
  );
}
