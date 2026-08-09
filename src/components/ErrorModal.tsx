import {
  Root as DialogRoot,
  Portal as DialogPortal,
  Overlay as DialogOverlay,
  Content as DialogContent,
  Title as DialogTitle,
  Description as DialogDescription
} from "@kobalte/core/dialog";
import { createMemo, createSignal, onCleanup } from "solid-js";
import type { ErrorModalEntry } from "../core/app/useErrorModalQueue";
import { formatErrorDetails } from "../core/app/errorDetails";

type ErrorModalProps = {
  open: boolean;
  entry: ErrorModalEntry | null;
  onDismiss: () => void;
};

export const ErrorModal = (props: ErrorModalProps) => {
  const [copyState, setCopyState] = createSignal<"idle" | "copied" | "failed">("idle");
  let copyResetTimer: ReturnType<typeof setTimeout> | null = null;

  const serializedDetails = createMemo(() => formatErrorDetails(props.entry?.details));

  const canCopyDetails = createMemo(() => serializedDetails().length > 0);

  const copyDetails = async () => {
    if (!canCopyDetails()) {
      return;
    }
    if (!navigator?.clipboard?.writeText) {
      setCopyState("failed");
      return;
    }
    try {
      await navigator.clipboard.writeText(serializedDetails());
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }

    if (copyResetTimer !== null) {
      clearTimeout(copyResetTimer);
      copyResetTimer = null;
    }
    copyResetTimer = setTimeout(() => {
      setCopyState("idle");
      copyResetTimer = null;
    }, 1200);
  };

  onCleanup(() => {
    if (copyResetTimer !== null) {
      clearTimeout(copyResetTimer);
      copyResetTimer = null;
    }
  });

  return (
    <DialogRoot
      open={props.open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          props.onDismiss();
        }
      }}
    >
      <DialogPortal>
        <DialogOverlay class="modal-backdrop error-dialog-backdrop" />
        <DialogContent class="modal-panel error-dialog-panel" aria-label="Error">
          <DialogTitle>{props.entry?.title ?? "Error"}</DialogTitle>
          <DialogDescription>{props.entry?.message ?? "An unknown error occurred."}</DialogDescription>

          {props.entry?.code ? <p class="error-code-label">Code: {props.entry.code}</p> : null}

          {canCopyDetails() ? (
            <details class="error-details-shell">
              <summary>Details</summary>
              <pre class="error-details-text">{serializedDetails()}</pre>
            </details>
          ) : null}

          <div class="modal-actions error-modal-actions">
            {canCopyDetails() ? (
              <button class="button subtle copy-details-button" onClick={() => void copyDetails()}>
                {copyState() === "copied" ? "Copied" : copyState() === "failed" ? "Copy failed" : "Copy details"}
              </button>
            ) : null}
            <button class="button" onClick={props.onDismiss}>OK</button>
          </div>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>
  );
};
