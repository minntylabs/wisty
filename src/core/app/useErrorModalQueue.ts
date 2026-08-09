import { createMemo, createSignal } from "solid-js";

export type ErrorModalEntry = {
  id: number;
  title: string;
  message: string;
  code?: string;
  details?: Record<string, unknown>;
};

/**
 * How many unanswered errors are worth keeping.
 *
 * Every one of these has to be dismissed by hand, so a queue is a bill the user
 * pays later. Something failing on a timer — a watcher on an unreadable file, a
 * save to a disconnected drive — could run this up without limit while nobody
 * was looking, and leave a stack of dialogs to click through.
 *
 * The earliest are kept rather than the latest: the first failure is usually
 * the cause and the ones after it the consequences.
 */
const MAX_QUEUED_ERRORS = 5;

/** What makes two reports the same report, as far as a reader is concerned. */
const sameError = (left: Omit<ErrorModalEntry, "id">, right: ErrorModalEntry) =>
  left.title === right.title && left.message === right.message && left.code === right.code;

export const useErrorModalQueue = () => {
  const [entries, setEntries] = createSignal<ErrorModalEntry[]>([]);
  let nextId = 1;

  const enqueue = (entry: Omit<ErrorModalEntry, "id">) => {
    const queued = entries();
    // The comparison includes the one on screen: a failure that repeats says
    // the same thing each time, and queueing it again asks the user to dismiss
    // the same news twice without telling them anything they have not read.
    if (queued.length >= MAX_QUEUED_ERRORS || queued.some((seen) => sameError(entry, seen))) {
      return;
    }
    const withId: ErrorModalEntry = { ...entry, id: nextId };
    nextId += 1;
    setEntries([...queued, withId]);
  };

  const dismissCurrent = () => {
    setEntries((current) => current.slice(1));
  };

  const clear = () => {
    setEntries([]);
  };

  const current = createMemo(() => entries()[0] ?? null);
  const open = createMemo(() => current() !== null);

  return {
    entries,
    current,
    open,
    enqueue,
    dismissCurrent,
    clear
  };
};
