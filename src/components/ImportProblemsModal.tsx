import { For, Show } from "solid-js";
import {
  Root as DialogRoot,
  Portal as DialogPortal,
  Overlay as DialogOverlay,
  Content as DialogContent,
  Title as DialogTitle,
  Description as DialogDescription,
  CloseButton as DialogCloseButton
} from "@kobalte/core/dialog";

type ImportProblemsModalProps = {
  open: boolean;
  /** One line per kind of problem, worst first. */
  problems: string[];
  cueCount: number;
  /**
   * Whether the recording has to be re-encoded on the way in. Worth saying
   * here because it is the slow part of an import, and this is the last moment
   * at which stopping costs nothing.
   */
  willConvert: boolean;
  onCancel: () => void;
  onImportAnyway: () => void;
};

/**
 * Shown before a container is written, never after.
 *
 * None of what it reports prevents a usable transcript, so the import is
 * offered rather than refused — but cue problems are the shape a mismatched
 * pair of files takes, and a conversion is minutes of work the user has not
 * been told about yet. Both are worth a question while this is still two files.
 */
export const ImportProblemsModal = (props: ImportProblemsModalProps) => (
  <DialogRoot
    open={props.open}
    onOpenChange={(open) => {
      if (!open) {
        props.onCancel();
      }
    }}
  >
    <DialogPortal>
      <DialogOverlay class="modal-backdrop large-file-dialog-backdrop" />
      <DialogContent class="modal-panel large-file-dialog-panel" aria-label="Before importing">
        <DialogTitle>{props.problems.length > 0 ? "Check the Transcript" : "Before Importing"}</DialogTitle>
        <DialogDescription>
          {props.cueCount === 1 ? "1 cue was read" : `${props.cueCount} cues were read`}
          {props.problems.length > 0 ? ", and some do not fit the recording:" : "."}
        </DialogDescription>

        <Show when={props.problems.length > 0}>
          <ul class="import-problems">
            <For each={props.problems}>{(problem) => <li>{problem}</li>}</For>
          </ul>
        </Show>

        <Show when={props.willConvert}>
          <p class="import-conversion-note">
            Wisty cannot play this recording as it is, so it will be converted while the
            container is built. That can take a few minutes for a long recording, and it is
            the only slow part of an import — you can stop it while it runs.
          </p>
        </Show>

        <div class="modal-actions">
          <DialogCloseButton class="button subtle">Cancel</DialogCloseButton>
          <button class="button" onClick={props.onImportAnyway}>
            {props.problems.length > 0 ? "Import Anyway" : "Import"}
          </button>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
);
