export const MAX_BACKUP_PLAINTEXT_BYTES = 32 * 1024 * 1024
// AES-GCM retains plaintext length; base64 expands it, plus bounded JSON metadata.
export const MAX_BACKUP_ENVELOPE_BYTES = Math.ceil(MAX_BACKUP_PLAINTEXT_BYTES / 3) * 4 + 1024
