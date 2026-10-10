/** URL-based ASR providers accept recording files up to five hours. */
export const MAX_ASR_DURATION_SECONDS = 5 * 60 * 60;
export const MAX_ASR_SOURCE_BYTES = 512 * 1024 * 1024;
export const MAX_ASR_WAV_BYTES = MAX_ASR_DURATION_SECONDS * 32_000 + 65_536;
export const ASR_CONVERSION_TIMEOUT_MS = 30 * 60 * 1000;
export const MAX_TENCENT_INLINE_BYTES = 5 * 1024 * 1024;
