import {
  Root as DialogRoot,
  Portal as DialogPortal,
  Overlay as DialogOverlay,
  Content as DialogContent,
  Title as DialogTitle,
  Description as DialogDescription
} from "@kobalte/core/dialog";

type FileSavingModalProps = {
  open: boolean;
  filePath: string;
  charsWritten: number;
  totalChars?: number;
  onCancel: () => void;
};

const clampPercent = (value: number): number => {
  if (value < 0) {
    return 0;
  }
  if (value > 100) {
    return 100;
  }
  return value;
};

const formatCharCount = (value: number): string => value.toLocaleString();

export const FileSavingModal = (props: FileSavingModalProps) => {
  const hasDeterminateProgress = () =>
    typeof props.totalChars === "number" && props.totalChars > 0;

  const progressPercent = () => {
    if (!hasDeterminateProgress()) {
      return 0;
    }
    return clampPercent((props.charsWritten / (props.totalChars as number)) * 100);
  };

  return (
    <DialogRoot open={props.open}>
      <DialogPortal>
        <DialogOverlay class="modal-backdrop file-loading-backdrop" />
        <DialogContent class="modal-panel file-loading-panel" aria-label="Saving file">
          <DialogTitle>Saving file...</DialogTitle>
          <DialogDescription>
            {hasDeterminateProgress()
              ? `Saved ${formatCharCount(props.charsWritten)} of ${formatCharCount(props.totalChars as number)} characters`
              : "Saving file contents"}
          </DialogDescription>
          <p class="file-loading-path" title={props.filePath}>{props.filePath}</p>

          <div class="file-loading-progress-shell" role="progressbar" aria-label="File saving progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={hasDeterminateProgress() ? Math.round(progressPercent()) : undefined}>
            <div
              class={`file-loading-progress-fill ${hasDeterminateProgress() ? "" : "indeterminate"}`.trim()}
              style={hasDeterminateProgress() ? { width: `${progressPercent()}%` } : undefined}
            />
          </div>

          <div class="modal-actions">
            <button class="button subtle" onClick={props.onCancel}>Cancel</button>
          </div>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
  );
};
