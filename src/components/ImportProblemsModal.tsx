import { For } from "solid-js";
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
  onCancel: () => void;
  onImportAnyway: () => void;
};

/**
 * Shown before a container is written, never after.
 *
 * None of these problems prevents a usable transcript, so the import is
 * offered rather than refused — but they are the shape a mismatched pair of
 * files takes, and that is worth a question while it is still two files.
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
      <DialogContent class="modal-panel large-file-dialog-panel" aria-label="Transcript problems">
        <DialogTitle>Check the Transcript</DialogTitle>
        <DialogDescription>
          {props.cueCount === 1 ? "1 cue was read" : `${props.cueCount} cues were read`}, and
          some do not fit the recording:
        </DialogDescription>
        <ul class="import-problems">
          <For each={props.problems}>{(problem) => <li>{problem}</li>}</For>
        </ul>
        <div class="modal-actions">
          <DialogCloseButton class="button subtle">Cancel</DialogCloseButton>
          <button class="button" onClick={props.onImportAnyway}>Import Anyway</button>
        </div>
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
);
