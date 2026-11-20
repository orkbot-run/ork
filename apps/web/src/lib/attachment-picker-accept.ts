import { ATTACHMENT_ALLOWED_MIME_TYPES } from "@orkbot/contracts";
import { attachmentExtensionForMimeType } from "@orkbot/core";

/**
 * Android's document picker can filter out CSV files when the accept attribute
 * combines many MIME types. Allow the picker to show files on Android; the
 * attachment preparation and API still reject unsupported formats and sizes.
 */
export function attachmentPickerAccept(userAgent: string): string {
  if (/\bAndroid\b/i.test(userAgent)) return "*/*";
  return [
    ...ATTACHMENT_ALLOWED_MIME_TYPES,
    ...ATTACHMENT_ALLOWED_MIME_TYPES.map(attachmentExtensionForMimeType),
  ].join(",");
}
