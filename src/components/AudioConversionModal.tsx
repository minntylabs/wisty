import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
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
  /**
   * Whether ffmpeg is still running. Building a container is two steps, and
   * saying "converting" through the second one — with the bar at its end — is
   * describing work that finished.
   */
  convertingAudio: boolean;
  /** Whether a cancellation has been asked for and not yet taken effect. */
  cancelling: boolean;
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

  /**
   * Whether the full output is showing, held here rather than in a `<details>`
   * element's own state. Native disclosure state lives in the DOM node, so
   * anything that replaces the node closes it — and this panel is rebuilt
   * around new output every 150ms while the conversion runs.
   */
  const [showOutput, setShowOutput] = createSignal(false);

  /**
   * Each conversion starts summarised — what the last one needed explaining
   * says nothing about this one — but only on the way *in*. This effect re-runs
   * whenever anything it reads changes, and `open` is read through a props
   * object its parent rebuilds as output arrives, so acting on the value rather
   * than the change would shut the output every 150ms.
   */
  let wasOpen = false;
  createEffect(() => {
    const open = props.open;
    if (open && !wasOpen) {
      setShowOutput(false);
    }
    wasOpen = open;
  });

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

  /** What the window is doing, in the order the user needs to hear it. */
  const positionLine = () => {
    if (props.cancelling) {
      return "Stopping…";
    }
    if (!props.convertingAudio) {
      return "Writing the container…";
    }
    if (props.positionSecs === null) {
      return "Starting…";
    }
    return props.durationSecs === null
      ? `Converted ${formatDuration(props.positionSecs)}`
      : `Converted ${formatDuration(props.positionSecs)} of ${formatDuration(props.durationSecs)}`;
  };

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
        <DialogContent class="modal-panel conversion-panel" aria-label="Importing">
          <DialogTitle>Importing</DialogTitle>
          <DialogDescription>
            {props.convertingAudio
              ? "This recording is in a format Wisty cannot play, so it is being converted as the container is built."
              : "Packaging the recording and the transcript into the container."}
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

          <p class="conversion-position">{positionLine()}</p>

          {/* Nothing to show until ffmpeg has said something, which it only
              does for a recording that needs converting. */}
          <Show when={props.lines.length > 0}>
            <div class="conversion-details">
              <button
                type="button"
                class="conversion-disclosure"
                aria-expanded={showOutput()}
                onClick={() => {
                  // Showing it again starts at the end, following. The flag
                  // belongs to the view rather than to the reader, and a stale
                  // one would leave a fresh log stuck at its top.
                  following = true;
                  setShowOutput((shown) => !shown);
                }}
              >
                {showOutput() ? "Hide ffmpeg's output" : "Show ffmpeg's output"}
              </button>
              <Show when={showOutput()}>
                <pre
                  class="conversion-log"
                  // Cleared when the element goes, so the effect below cannot
                  // scroll a node that has left the document and `following`
                  // cannot be read from one.
                  ref={(element) => {
                    log = element;
                    onCleanup(() => {
                      if (log === element) {
                        log = undefined;
                      }
                    });
                  }}
                  onScroll={noteScroll}
                >
                  <For each={props.lines}>{(line) => <div>{line}</div>}</For>
                </pre>
              </Show>
            </div>
          </Show>

          <div class="modal-actions">
            <button class="button subtle" disabled={props.cancelling} onClick={props.onCancel}>
              {props.cancelling ? "Stopping…" : "Cancel Import"}
            </button>
          </div>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
  );
};
