# File Transfer Limits

The frontend and Rust backend have separate jobs here. The frontend applies
user-facing file-size policy before opening a file; Rust enforces the same
limits for files passed on the command line, where the frontend has not yet
had a chance to inspect them.

| Policy | Value | Frontend | Rust |
| --- | ---: | --- | --- |
| Soft open warning | 50 MiB | `useFileLifecycle.ts` | CLI launch handling |
| Hard open refusal | 1 GiB | `useFileLifecycle.ts` | CLI launch handling |
| Default read chunk | 256 KiB | file and launch reads | requested by lifecycle |
| Minimum read chunk | 4 KiB | file reads | launch-stream clamp |
| Maximum read chunk | 1 MiB | file reads | launch-stream clamp |

These values are deliberately duplicated because TypeScript and Rust do not
share a runtime configuration. Changes must update both implementations and
the file-service chunk-limit test. The frontend thresholds are UX policy; the
Rust limits are the enforcement boundary for command-line launch files.

Save transfers use 256 KiB character chunks. Their UTF-8 byte size varies, so
the backend writes each received string rather than applying a byte-based read
chunk limit.
