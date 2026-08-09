import { For, createEffect } from "solid-js";
import {
  Root as DialogRoot,
  Portal as DialogPortal,
  Overlay as DialogOverlay,
  Content as DialogContent,
  Title as DialogTitle,
  Description as DialogDescription
} from "@kobalte/core/dialog";

type AudioConversionModalProps = {
  open: boolean;
  /** ffmpeg's own output, oldest first. */
  lines: string[];
  /** How far through the recording it is, 0 to 1, or `null` if not yet known. */
  progress: number | null;
  onCancel: () => void;
};

/**
 * Shown while a recording is converted on the way into a container.
 *
 * The output is ffmpeg's, verbatim. It is the only honest progress report
 * available — ffmpeg says what it is reading, what it is writing and how far
 * through it is — and when a conversion fails it is also the explanation.
 *
 * Dismissing stops the conversion, which ends the import. There is no "close
 * but carry on": the conversion is the import at this point, and a window that
 * could be dismissed while work continued invisibly would be worse than none.
 */
export const AudioConversionModal = (props: AudioConversionModalProps) => {
  let log: HTMLPreElement | undefined;

  // Follows the output, which is the only reason to show it live.
  createEffect(() => {
    props.lines.length;
    if (log) {
      log.scrollTop = log.scrollHeight;
    }
  });

  return (
    <DialogRoot
      open={props.open}
      onOpenChange={(open) => {
        if (!open) {
          props.onCancel();
        }
      }}
    >
      <DialogPortal>
        <DialogOverlay class="modal-backdrop file-loading-backdrop" />
        <DialogContent class="modal-panel conversion-panel" aria-label="Converting the recording">
          <DialogTitle>Converting the Recording</DialogTitle>
          <DialogDescription>
            This recording is in a format Wisty cannot play, so it is being converted as
            it is imported. This happens once, when the container is built.
          </DialogDescription>
          <div
            class="file-loading-progress-shell"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={props.progress === null ? undefined : Math.round(props.progress * 100)}
          >
            <div
              class={`file-loading-progress-fill ${props.progress === null ? "indeterminate" : ""}`.trim()}
              style={props.progress === null ? undefined : { width: `${props.progress * 100}%` }}
            />
          </div>
          <pre class="conversion-log" ref={log}>
            <For each={props.lines}>{(line) => <div>{line}</div>}</For>
          </pre>
          <div class="modal-actions">
            <button class="button subtle" onClick={props.onCancel}>Cancel Import</button>
          </div>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
  );
};
