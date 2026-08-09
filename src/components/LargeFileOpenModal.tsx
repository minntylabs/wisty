import {
  Root as DialogRoot,
  Portal as DialogPortal,
  Overlay as DialogOverlay,
  Content as DialogContent,
  Title as DialogTitle,
  Description as DialogDescription,
  CloseButton as DialogCloseButton
} from "@kobalte/core/dialog";
import { formatSizeMb } from "../core/files/formatSize";

type LargeFileOpenModalProps = {
  open: boolean;
  kind: "confirm" | "blocked";
  filePath: string;
  sizeBytes: number;
  onCancel: () => void;
  onOpenAnyway: () => void;
  onAcknowledge: () => void;
};

export const LargeFileOpenModal = (props: LargeFileOpenModalProps) => {
  const title = () => (props.kind === "blocked" ? "File Too Large" : "Large File");
  const description = () =>
    props.kind === "blocked"
      ? `This file is ${formatSizeMb(props.sizeBytes)} MB. Wisty cannot open files of 1024 MB or larger.`
      : `This file is ${formatSizeMb(props.sizeBytes)} MB. Opening it may reduce responsiveness.`;

  return (
    <DialogRoot
      open={props.open}
      onOpenChange={(open) => {
        if (open) {
          return;
        }
        if (props.kind === "blocked") {
          props.onAcknowledge();
          return;
        }
        props.onCancel();
      }}
    >
      <DialogPortal>
        <DialogOverlay class="modal-backdrop large-file-dialog-backdrop" />
        <DialogContent class="modal-panel large-file-dialog-panel" aria-label="Large file warning">
          <DialogTitle>{title()}</DialogTitle>
          <DialogDescription>{description()}</DialogDescription>
          <p class="large-file-path" title={props.filePath}>{props.filePath}</p>
          <div class="modal-actions">
            {props.kind === "confirm" ? (
              <>
                <DialogCloseButton class="button subtle">Cancel</DialogCloseButton>
                <button class="button" onClick={props.onOpenAnyway}>Open Anyway</button>
              </>
            ) : (
              <DialogCloseButton class="button">OK</DialogCloseButton>
            )}
          </div>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
  );
};
