/** Stable public URL of one immutable MEDIA-1 WebP rendition. */
export function renditionPath(assetId: string, width: number): string {
  return `/v1/media/files/${assetId}/${width}.webp`;
}
