import { Prisma } from '@euroteranga/database';
import { renditionPath } from './media-path.js';

/** Reusable MEDIA-1 projection for public vehicle and trip views. */
export const publicMediaSelect = {
  id: true,
  status: true,
  altText: true,
  caption: true,
  credit: true,
  width: true,
  height: true,
  focalX: true,
  focalY: true,
  renditions: {
    orderBy: { width: 'asc' },
    select: { width: true, height: true },
  },
} satisfies Prisma.PublicMediaAssetSelect;

export type PublicMediaRow = Prisma.PublicMediaAssetGetPayload<{
  select: typeof publicMediaSelect;
}>;

/** Archived images are never returned by a public aggregate. */
export function publicMediaView(asset: PublicMediaRow | null) {
  if (!asset || asset.status !== 'ACTIVE') return null;
  return {
    id: asset.id,
    altText: asset.altText,
    caption: asset.caption,
    credit: asset.credit,
    width: asset.width,
    height: asset.height,
    focalX: asset.focalX,
    focalY: asset.focalY,
    renditions: asset.renditions.map((rendition) => ({
      width: rendition.width,
      height: rendition.height,
      path: renditionPath(asset.id, rendition.width),
    })),
  };
}
