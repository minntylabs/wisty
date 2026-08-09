import { For, Show, createEffect, createMemo } from "solid-js";
import {
  Root as DialogRoot,
  Portal as DialogPortal,
  Overlay as DialogOverlay,
  Content as DialogContent,
  Title as DialogTitle,
  Description as DialogDescription
} from "@kobalte/core/dialog";
import { formatDuration, summariseConversion } from "../core/tsf/conversionSummary";
import { isPinnedToBottom } from "../core/tsf/logScroll";

type AudioConversionModalProps = {
  open: boolean;
  /** ffmpeg's own output, oldest first. */
  lines: string[];
  /** The recording's length, once ffmpeg has read it. */
  durationSecs: number | null;
  /** How far into the recording it has got. */
  positionSecs: number | null;
  onCancel: () => void;
};

/**
 * Shown while a recording is converted on the way into a container.
 *
 * The facts are ffmpeg's, summarised: which recording, what it is, what it is
 * becoming. Its full output is a wall of build flags and stream maps written
 * for ffmpeg's own developers, so it waits behind a disclosure — where it is
 * still the thing that explains a conversion that goes wrong.
 *
 * Dismissing stops the conversion, which ends the import. There is no "close
 * but carry on": the conversion is the import at this point, and a window that
 * could be dismissed while work continued invisibly would be worse than none.
 */
export const AudioConversionModal = (props: AudioConversionModalProps) => {
  let log: HTMLPreElement | undefined;
  /**
   * Following is for people watching it go by. Someone who has scrolled up is
   * reading, and yanking them back to the bottom every 150ms takes the output
   * away from them faster than they can read it.
   */
  let following = true;

  const summary = createMemo(() => summariseConversion(props.lines));
  const progress = createMemo(() => {
    const { durationSecs, positionSecs } = props;
    if (durationSecs === null || durationSecs <= 0 || positionSecs === null) {
      return null;
    }
    // Clamped: ffmpeg can pass its own reported length by a fraction of a
    // second at the end, and a bar that overshoots looks broken.
    return Math.min(1, positionSecs / durationSecs);
  });

  createEffect(() => {
    props.lines.length;
    if (log && following) {
      log.scrollTop = log.scrollHeight;
    }
  });

  const noteScroll = () => {
    if (!log) {
      return;
    }
    following = isPinnedToBottom(log);
  };

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

          <dl class="conversion-facts">
            <Show when={summary().source}>
              {(source) => (
                <>
                  <dt>Source file</dt>
                  <dd>{source()}</dd>
                </>
              )}
            </Show>
            <Show when={summary().from}>
              {(from) => (
                <>
                  <dt>Source format</dt>
                  <dd>{from()}</dd>
                </>
              )}
            </Show>
            <Show when={summary().to}>
              {(to) => (
                <>
                  <dt>Output format</dt>
                  <dd>{to()}</dd>
                </>
              )}
            </Show>
            <Show when={props.durationSecs !== null}>
              <dt>Length</dt>
              <dd>{formatDuration(props.durationSecs as number)}</dd>
            </Show>
          </dl>

          <div
            class="file-loading-progress-shell"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress() === null ? undefined : Math.round((progress() as number) * 100)}
          >
            <div
              class={`file-loading-progress-fill ${progress() === null ? "indeterminate" : ""}`.trim()}
              style={progress() === null ? undefined : { width: `${(progress() as number) * 100}%` }}
            />
          </div>

          <p class="conversion-position">
            {props.positionSecs === null
              ? "Starting…"
              : props.durationSecs === null
                ? `Converted ${formatDuration(props.positionSecs)}`
                : `Converted ${formatDuration(props.positionSecs)} of ${formatDuration(props.durationSecs)}`}
          </p>

          <details class="conversion-details">
            <summary>ffmpeg's output</summary>
            <pre class="conversion-log" ref={log} onScroll={noteScroll}>
              <For each={props.lines}>{(line) => <div>{line}</div>}</For>
            </pre>
          </details>

          <div class="modal-actions">
            <button class="button subtle" onClick={props.onCancel}>Cancel Import</button>
          </div>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
  );
};
